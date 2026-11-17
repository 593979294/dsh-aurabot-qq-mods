// remote.mjs —— 远程协助通道（按主人指令生成一次性邀请链接，主人用浏览器接管这台电脑）
// 来源：aurabot 模块库 modules/windows-ops（本仓库原创，MIT）
// 作用：起一个只在本机/局域网可达的小 HTTP 服务，用一次性令牌换一张网页：
//       网页里实时看屏幕（screen.capture 的 JPEG 帧），并把手势/输入换算成这台电脑的鼠标与键盘动作。
// 契约：export function createRemoteAssist({ ops, getSettings, dataDir, log?, now?, readFile?, lanIp? })
//   → { invite({minutes?, publicBase?, bind?, port?}) , stop(reason), status(), handleRequest?（测试用） }
// 安全模型（这是本模块里唯一对外开放端口的部件，闸门全部在这里）：
//   · 默认关：面板「允许远程协助」不开，invite 直接拒绝，端口根本不起；
//   · 只有主人能开：入口层的 /wops assist 命令与工具都只认主人；
//   · 一次性令牌：10 位十六进制、默认 15 分钟（1~60）、单会话、错令牌一律 404、过期自动关服务；
//   · 看可以、动要另开：面板「允许键鼠模拟」没开时，/input 全部 403，只能看画面；
//   · 限速：画面 200ms 一帧上限、输入 1 秒 30 个动作上限；每个动作都落操作日志（日志里不写令牌）；
//   · 远端输入绕过了「危险操作确认队列」（否则一次点击就要回 QQ 批一次，没法用）。这是显式设计：
//     邀请链接本身就是主人当场给出的授权，令牌有效期就是授权有效期——所以链接只能发给主人本人。
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { networkInterfaces } from 'node:os'
import { readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

const TOKEN_TTL_MIN = 15
const FRAME_GAP_MS = 200 // 画面最快 5 帧/秒，够看、不烧 CPU
const INPUT_PER_SEC = 30 // 输入限速
const MAX_TEXT = 500

/** 归一化 0~1000 → 屏幕像素（虚拟屏幕可能是多显示器，rect 带原点）。 */
function toScreen(nx, ny, rect) {
  const clamp = (v) => Math.min(1000, Math.max(0, Number(v) || 0)) / 1000
  return {
    x: Math.round(rect.x + clamp(nx) * rect.width),
    y: Math.round(rect.y + clamp(ny) * rect.height),
  }
}

/** 本机局域网 IPv4（优先 192.168 / 10 / 172.16-31；没有就 127.0.0.1）。 */
export function detectLanIp() {
  try {
    const list = []
    for (const name of Object.keys(networkInterfaces())) {
      for (const it of networkInterfaces()[name] || []) {
        if (it.family === 'IPv4' && !it.internal) list.push(it.address)
      }
    }
    return list.find((a) => a.startsWith('192.168.'))
      || list.find((a) => a.startsWith('10.'))
      || list.find((a) => /^172\.(1[6-9]|2\d|3[01])\./.test(a))
      || list[0] || '127.0.0.1'
  } catch { return '127.0.0.1' }
}

/** 组装邀请网页（内联 CSS/JS，不引外链；令牌写在路径里，页面本身不含其他凭据）。 */
function pageHtml(token) {
  const base = '/r/' + token
  return `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<meta name="referrer" content="no-referrer">
<title>逛电脑 · 远程协助</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  body { margin: 0; background: #0f1216; color: #e6e8eb; font: 14px/1.5 -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
  header { display: flex; align-items: center; gap: 8px; padding: 10px 12px; background: #161b22; border-bottom: 1px solid #262d36; position: sticky; top: 0; z-index: 5; }
  header b { font-size: 14px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: #3fb950; }
  .dot.off { background: #e5484d; }
  .meta { margin-left: auto; font-size: 12px; color: #9aa4af; display: flex; gap: 10px; align-items: center; }
  .wrap { padding: 10px; }
  #stage { position: relative; background: #000; border: 1px solid #262d36; border-radius: 8px; overflow: hidden; touch-action: manipulation; }
  #screen { display: block; width: 100%; height: auto; user-select: none; -webkit-user-drag: none; cursor: crosshair; }
  #hint { position: absolute; inset: auto 0 0; padding: 6px 10px; font-size: 12px; color: #c9d1d9; background: linear-gradient(transparent, rgba(0,0,0,.7)); pointer-events: none; }
  .bar { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
  button { appearance: none; border: 1px solid #30363d; background: #21262d; color: #e6e8eb; border-radius: 8px; padding: 8px 12px; font-size: 13px; }
  button:active { background: #30363d; }
  button.on { border-color: #2f81f7; color: #79c0ff; }
  button.danger { border-color: #e5484d; color: #ff7b72; }
  .row { display: flex; gap: 6px; margin-top: 8px; }
  input[type=text] { flex: 1; min-width: 0; background: #0d1117; border: 1px solid #30363d; color: #e6e8eb; border-radius: 8px; padding: 9px 10px; font-size: 14px; }
  .tip { margin-top: 12px; font-size: 12px; color: #8b949e; line-height: 1.7; }
  .tip b { color: #c9d1d9; }
  .toast { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); background: #21262d; border: 1px solid #30363d; color: #e6e8eb; padding: 8px 14px; border-radius: 8px; opacity: 0; transition: opacity .2s; pointer-events: none; }
  .toast.on { opacity: 1; }
</style></head>
<body>
<header>
  <span class="dot" id="dot"></span><b>逛电脑 · 远程协助</b>
  <span class="meta"><span id="left">—</span><span id="act">0 次操作</span></span>
</header>
<div class="wrap">
  <div id="stage">
    <img id="screen" alt="屏幕画面加载中…">
    <div id="hint">点一下画面 = 在该处点击鼠标</div>
  </div>
  <div class="bar">
    <button id="btnLeft" class="on">左键点击</button>
    <button id="btnRight">右键点击</button>
    <button id="btnEnter">Enter</button>
    <button id="btnEsc">Esc</button>
    <button id="btnTab">Tab</button>
    <button id="btnBack">退格</button>
    <button id="btnStop" class="danger">断开</button>
  </div>
  <div class="row">
    <input id="text" type="text" placeholder="要输入的文字（点画面选好位置再发）" autocomplete="off">
    <button id="btnText">发送</button>
  </div>
  <div class="tip">
    <b>这是主人本人的远程协助链接。</b>画面每 0.7 秒刷新一帧；点击会在这台电脑上真实发生。
    用完点「断开」立刻失效，或回 QQ 发 <b>/wops assist stop</b>。
    别把链接转发给别人，也别在公共网络里开着不用。
  </div>
</div>
<div class="toast" id="toast"></div>
<script>
(() => {
  const BASE = ${JSON.stringify(base)};
  const img = document.getElementById('screen');
  const dot = document.getElementById('dot');
  const leftEl = document.getElementById('left');
  const actEl = document.getElementById('act');
  const toastEl = document.getElementById('toast');
  let button = 'left';
  let stopped = false;
  let actions = 0;
  let lastError = '';
  const toast = (t) => { toastEl.textContent = t; toastEl.classList.add('on'); clearTimeout(toast._t); toast._t = setTimeout(() => toastEl.classList.remove('on'), 1600); };

  async function post(type, payload) {
    if (stopped) return;
    try {
      const r = await fetch(BASE + '/input', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type, ...payload }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.ok === false) { toast(j.error || ('操作失败 HTTP ' + r.status)); return; }
      actions++; actEl.textContent = actions + ' 次操作';
    } catch (e) { toast('网络错误：' + e.message); }
  }

  // 画面：定时换 src，失败时标红但继续重试
  function frame() {
    if (stopped) return;
    img.src = BASE + '/frame?n=' + Date.now();
  }
  img.addEventListener('load', () => { dot.classList.remove('off'); });
  img.addEventListener('error', () => { dot.classList.add('off'); lastError = '画面拉取失败'; });
  frame();
  setInterval(frame, 700);

  // 点画面 = 在该处点击
  img.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    const box = img.getBoundingClientRect();
    const nx = Math.round(((ev.clientX - box.left) / box.width) * 1000);
    const ny = Math.round(((ev.clientY - box.top) / box.height) * 1000);
    post('click', { nx, ny, button });
  });

  // 状态：剩余时间/操作数
  async function state() {
    if (stopped) return;
    try {
      const r = await fetch(BASE + '/state', { cache: 'no-store' });
      const j = await r.json();
      if (j.ok === false) { dot.classList.add('off'); toast(j.error || '通道已失效'); stopped = true; return; }
      const m = Math.max(0, Math.ceil((j.remainingMs || 0) / 60000));
      leftEl.textContent = m + ' 分钟';
      actEl.textContent = (j.actions || actions) + ' 次操作';
      if (j.expired) { stopped = true; dot.classList.add('off'); toast('邀请已过期'); }
    } catch { dot.classList.add('off'); }
  }
  setInterval(state, 2000);

  const pick = (el, value) => {
    for (const b of [document.getElementById('btnLeft'), document.getElementById('btnRight')]) b.classList.remove('on');
    el.classList.add('on'); button = value;
  };
  document.getElementById('btnLeft').onclick = (e) => pick(e.target, 'left');
  document.getElementById('btnRight').onclick = (e) => pick(e.target, 'right');

  const key = (k) => post('key', { key: k });
  document.getElementById('btnEnter').onclick = () => key('enter');
  document.getElementById('btnEsc').onclick = () => key('esc');
  document.getElementById('btnTab').onclick = () => key('tab');
  document.getElementById('btnBack').onclick = () => key('backspace');

  const sendText = () => {
    const t = document.getElementById('text').value;
    if (!t) return toast('先输入要发送的文字');
    post('text', { text: t }).then(() => { document.getElementById('text').value = ''; });
  };
  document.getElementById('btnText').onclick = sendText;
  document.getElementById('text').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); sendText(); } });

  document.getElementById('btnStop').onclick = async () => {
    try { await fetch(BASE + '/stop', { method: 'POST' }); } catch {}
    stopped = true; dot.classList.add('off'); toast('已断开');
  };

  // 外接键盘：输入框外按 Enter/Esc/退格也转过去
  window.addEventListener('keydown', (e) => {
    if (e.target && e.target.tagName === 'INPUT') return;
    const map = { Enter: 'enter', Escape: 'esc', Tab: 'tab', Backspace: 'backspace' };
    if (map[e.key]) { e.preventDefault(); key(map[e.key]); }
  });
})();
</script>
</body></html>`
}

export function createRemoteAssist({ ops, getSettings, dataDir, log = {}, now = () => Date.now(), readFile = readFileSync, lanIp = detectLanIp } = {}) {
  let srv = null
  let srvPort = 0
  let srvBind = ''
  let session = null // { token, createdAt, expiresAt, minutes, actions, dropped, lastActionAt, lastLogAt }
  const sockets = new Set()
  let frame = { buf: null, at: 0, rect: null }

  const shotsDir = () => join(dataDir, 'shots')
  const settings = () => getSettings() || {}

  /** 清旧帧（只删 60 秒前、保留最近 80 张；不删正在回传的那张）。 */
  function pruneFrames() {
    try {
      const names = readdirSync(shotsDir()).filter((n) => /^(frame|shot)-[^\s]+\.jpg$/.test(n))
      if (names.length <= 80) return
      const files = names.map((n) => ({ n, t: statSync(join(shotsDir(), n)).mtimeMs })).sort((a, b) => b.t - a.t)
      for (const f of files.slice(80)) if (now() - f.t > 60_000) { try { unlinkSync(join(shotsDir(), f.n)) } catch {} }
    } catch {}
  }

  function sendJson(res, code, obj) {
    const body = Buffer.from(JSON.stringify(obj))
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' })
    res.end(body)
  }

  function sendText(res, code, text) {
    res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
    res.end(text)
  }

  function sendHtml(res, html) {
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'x-frame-options': 'DENY',
      'content-security-policy': "default-src 'none'; img-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'",
    })
    res.end(html)
  }

  function sendImage(res, buf) {
    res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'no-store', 'content-length': buf.length })
    res.end(buf)
  }

  /** 读请求体（上限 16KB，超了直接断）。 */
  function readBody(req, limit = 16 * 1024) {
    return new Promise((resolve, reject) => {
      const chunks = []
      let total = 0
      req.on('data', (c) => {
        total += c.length
        if (total > limit) { reject(new Error('请求体太大')); try { req.destroy() } catch {} ; return }
        chunks.push(c)
      })
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      req.on('error', reject)
    })
  }

  /** 取一帧（200ms 内复用上一帧，避免连续点刷新把 CPU 打满）。 */
  async function captureFrame(width, quality) {
    if (frame.buf && now() - frame.at < FRAME_GAP_MS) return frame
    const cap = await ops.run('screen.capture', { maxWidth: width, quality })
    if (!cap?.ok || !cap?.data?.file) throw new Error(cap?.message || '截屏失败')
    const buf = readFile(cap.data.file)
    const d = cap.data
    frame = {
      buf,
      at: now(),
      rect: {
        x: Number(d.x) || 0,
        y: Number(d.y) || 0,
        width: Number(d.width) || Number(d.scaledWidth) || 1,
        height: Number(d.height) || Number(d.scaledHeight) || 1,
      },
    }
    pruneFrames()
    return frame
  }

  /** 执行一个远端动作（已经过令牌/开关/限速校验）。 */
  async function runInput(body) {
    // 坐标按「最近一帧的虚拟屏幕矩形」换算；没有帧就先读一次屏幕尺寸
    let rect = frame.rect
    if (!rect) {
      try {
        const info = await ops.run('screen.info', {})
        if (info?.ok && info.data) rect = info.data
      } catch { /* 读不到就用占位矩形，下面按 0~1 处理 */ }
    }
    rect = rect || { x: 0, y: 0, width: 1, height: 1 }
    const type = String(body.type || '')
    switch (type) {
      case 'move': {
        const p = toScreen(body.nx, body.ny, rect)
        return ops.run('mouse.move', p)
      }
      case 'click': {
        const p = toScreen(body.nx, body.ny, rect)
        return ops.run('mouse.click', { ...p, button: body.button === 'right' ? 'right' : 'left' })
      }
      case 'text': {
        const text = String(body.text ?? '')
        if (!text) return { ok: false, message: '没有要输入的文字' }
        if (text.length > MAX_TEXT) return { ok: false, message: `一次最多输入 ${MAX_TEXT} 个字` }
        const w = await ops.run('clipboard.write', { text })
        if (!w?.ok) return w
        return ops.run('paste', {}) // Ctrl+V：绕开中文输入法，见 ops.mjs 的说明
      }
      case 'key': {
        return ops.run('key.press', { key: String(body.key || '') })
      }
      default:
        return { ok: false, message: `不认识的输入类型：${type}` }
    }
  }

  async function handleRequest(req, res) {
    try {
      const url = new URL(req.url || '/', 'http://local')
      const m = url.pathname.match(/^\/r\/([a-f0-9]+)(\/.*)?$/)
      if (!m) return sendText(res, 404, '没有这个页面')
      const token = m[1]
      const sub = m[2] || '/'
      if (!session || token !== session.token) return sendText(res, 404, '邀请已失效或链接不对')
      // 面板把总开关/远程协助关掉 = 立即收工（否则开关像是关不掉）
      if (settings().enabled === false || settings().remoteAllow !== true) {
        sendText(res, 403, '远程协助已被主人关掉（面板「允许远程协助」或总开关）')
        res.on('finish', () => setImmediate(() => stop('开关被关掉')))
        return
      }
      if (now() >= session.expiresAt) {
        // 先把 410 发完再关服务：closeServer 会销毁当前 socket，顺序反了浏览器就看不到提示
        sendText(res, 410, '邀请过期了，回 QQ 发 /wops assist 重新生成')
        res.on('finish', () => setImmediate(() => stop('邀请过期')))
        return
      }

      if (sub === '/') return sendHtml(res, pageHtml(session.token))

      if (sub === '/frame') {
        try {
          const f = await captureFrame(Number(settings().remoteMaxWidth) || 1280, Number(settings().remoteQuality) || 55)
          return sendImage(res, f.buf)
        } catch (e) {
          if (frame.buf) return sendImage(res, frame.buf)
          return sendText(res, 502, '截屏失败：' + (e?.message || e))
        }
      }

      if (sub === '/state') {
        return sendJson(res, 200, {
          ok: true,
          actions: session.actions,
          remainingMs: Math.max(0, session.expiresAt - now()),
          expired: now() >= session.expiresAt,
          allowInput: settings().allowInput === true && settings().remoteAllow === true,
        })
      }

      if (sub === '/input') {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '只支持 POST' })
        const s = settings()
        if (s.remoteAllow !== true) return sendJson(res, 403, { ok: false, error: '远程协助没开：面板「允许远程协助」打开了才能操作' })
        if (s.allowInput !== true) return sendJson(res, 403, { ok: false, error: '只能看不能操作：面板「允许键鼠模拟」没开' })
        const t = now()
        // 限速：同一秒最多 INPUT_PER_SEC 个动作（按秒重置的滑动窗口，手机连点也不会误伤）
        if (!session.windowStart || t - session.windowStart >= 1000) { session.windowStart = t; session.windowCount = 0 }
        session.windowCount = (session.windowCount || 0) + 1
        if (session.windowCount > INPUT_PER_SEC) { session.dropped++; return sendJson(res, 429, { ok: false, error: '操作太快，缓一下' }) }

        let body = {}
        try { body = JSON.parse(await readBody(req) || '{}') } catch { return sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' }) }
        const r = await runInput(body)
        if (!r?.ok) return sendJson(res, 200, { ok: false, error: r?.message || '动作失败' })
        session.actions++
        session.lastActionAt = t
        // 日志：每 2 秒最多一条，先记动作类型；令牌一律不落日志
        if (t - session.lastLogAt > 2000) {
          session.lastLogAt = t
          log.info?.(`[远程协助] ${String(body.type)}${body.button === 'right' ? '(右键)' : ''} → ${String(r.message || 'ok').slice(0, 80)}`)
        }
        return sendJson(res, 200, { ok: true })
      }

      if (sub === '/stop') {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '只支持 POST' })
        sendJson(res, 200, { ok: true })
        res.on('finish', () => setImmediate(() => stop('主人在页面点断开')))
        return
      }

      return sendText(res, 404, '没有这个页面')
    } catch (e) {
      log.warn?.('[远程协助] 请求出错：', e?.message || e)
      try { sendJson(res, 500, { ok: false, error: '服务出错' }) } catch {}
    }
  }

  /** 起服务（端口冲突/绑定失败都翻成人话）。 */
  function ensureServer(port, bind) {
    if (srv && srvPort === port && srvBind === bind) return Promise.resolve()
    if (srv) closeServer()
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => { handleRequest(req, res) })
      server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)) })
      server.on('error', (e) => { srv = null; reject(new Error(e.code === 'EADDRINUSE' ? `端口 ${port} 被别的程序占了，去面板换一个端口` : (e.message || String(e)))) })
      server.listen(port, bind, () => {
        srv = server
        srvPort = server.address().port
        srvBind = bind
        log.info?.(`[远程协助] 服务已起：${bind}:${srvPort}`)
        resolve()
      })
    })
  }

  function closeServer() {
    for (const s of sockets) { try { s.destroy() } catch {} }
    sockets.clear()
    if (srv) { try { srv.close() } catch {} }
    srv = null
    srvPort = 0
    srvBind = ''
  }

  /**
   * 生成邀请（也是「邀请对方远程协助」的落点）。
   * @param {{minutes?: number, publicBase?: string, bind?: string, port?: number}} o
   *   publicBase：对外地址（如 frp/隧道域名）；不填就用本机局域网 IP + 端口。
   */
  async function invite({ minutes, publicBase, bind, port } = {}) {
    const s = settings()
    if (s.remoteAllow !== true) {
      return { ok: false, message: '远程协助没开：先在面板打开「允许远程协助」，再发指令' }
    }
    if (session) {
      return {
        ok: true, reused: true, token: session.token,
        url: session.url, port: session.port, bind: session.bind,
        expiresAt: session.expiresAt, minutes: session.minutes,
        message: `通道已经开着（还剩 ${Math.max(0, Math.ceil((session.expiresAt - now()) / 60000))} 分钟），链接没变`,
      }
    }
    const mins = Number.isFinite(Number(minutes)) && Number(minutes) > 0
      ? Math.min(60, Math.max(1, Math.round(Number(minutes))))
      : Math.min(60, Math.max(1, Math.round(Number(s.remoteMinutes) || TOKEN_TTL_MIN)))
    // port 显式传 0 = 让系统挑空闲端口（单测用）；其余情况夹在 1024~65535
    const rawPort = port === 0 ? 0 : Math.round(Number(port) || Number(s.remotePort) || 17890)
    const p = rawPort === 0 ? 0 : Math.min(65535, Math.max(1024, rawPort))
    const b = String(bind || s.remoteBind || '0.0.0.0')
    try { await ensureServer(p, b) } catch (e) { return { ok: false, message: `远程协助起不来：${e.message}` } }
    const token = randomBytes(5).toString('hex')
    const base = String(publicBase ?? s.remotePublicBase ?? '').trim() || `http://${lanIp()}:${srvPort}`
    const url = `${base.replace(/\/+$/, '')}/r/${token}`
    session = {
      token, createdAt: now(), expiresAt: now() + mins * 60_000, minutes: mins,
      url, port: srvPort, bind: b, actions: 0, dropped: 0, lastActionAt: 0, lastLogAt: 0,
    }
    frame = { buf: null, at: 0, rect: null }
    log.info?.(`[远程协助] 已生成邀请：端口 ${srvPort}，${mins} 分钟有效（令牌不落日志）`)
    return { ok: true, token, url, port: srvPort, bind: b, minutes: mins, expiresAt: session.expiresAt }
  }

  /** 关闭通道（邀请是一次性的，停止即失效并释放端口）。 */
  function stop(reason = '主人停止') {
    if (!session) { closeServer(); return { ok: false, message: '现在没有开着的远程协助' } }
    const done = { url: session.url, minutes: session.minutes, actions: session.actions, remainingMs: Math.max(0, session.expiresAt - now()) }
    session = null
    frame = { buf: null, at: 0, rect: null }
    closeServer()
    log.info?.(`[远程协助] 已关闭（${reason}）：共 ${done.actions} 次操作`)
    return { ok: true, message: `远程协助已关闭（本次 ${done.actions} 次操作）`, actions: done.actions }
  }

  function status() {
    if (!session) return { active: false, settings: settings(), port: srvPort || 0 }
    return {
      active: true,
      tokenMasked: session.token.slice(0, 3) + '…' + session.token.slice(-2),
      url: session.url,
      port: session.port,
      bind: session.bind,
      startsAt: session.createdAt,
      expiresAt: session.expiresAt,
      remainingMs: Math.max(0, session.expiresAt - now()),
      minutes: session.minutes,
      actions: session.actions,
      dropped: session.dropped,
    }
  }

  function dispose() { stop('模块停下') }

  return { invite, stop, status, dispose, handleRequest }
}
