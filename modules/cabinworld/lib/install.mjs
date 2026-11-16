// 一键安装小屋世界：从 GitHub Release 下载 CabinWorld-win64.zip，解压到游戏目录，
// 保留已有的 data/（存档）。Windows 专用（游戏是 Windows x64 原生程序）。
//
// 只用 Node 标准库 + 系统自带 tar.exe / PowerShell。

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { killBridge, isGameRunning, hostPidFile, ensureHost, startHost } from './host.mjs'
import { exePath, exeName, assertKillable } from './exe.mjs'
import crypto from 'node:crypto'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PATCHES = path.join(HERE, 'patches', 'apply.mjs')

const REPO = 'BabyBus2022/cabin-world'
const UA = 'aurabot-cabinworld-installer'
const API_LATEST = 'https://api.github.com/repos/' + REPO + '/releases/latest'
const ZIP_RE = /\.zip$/i
const WIN_RE = /win64|windows|win-x64/i
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000
const ASSET_HOSTS = ['github.com', 'objects.githubusercontent.com']
// 装法：包里有的一律装，只有这几样必须留着用户自己的 ——
// 白名单式的“只装认识的”会漏掉新版本新增的文件（1.0 时代的白名单就漏了 1.1 的
// update.cmd、PATCH-CHOICES.json 等 6 个），以后上游再加东西也不会漏。
const KEEP_TOP = new Set(['data', 'backups', '__download', '__unpack', '.git', '.gitignore', '.github', 'node_modules'])
// 桥配置要保留（displayName、hostName、端口、dataDir 都在里面），官方升级说明也要求不得用包内示例覆盖。
const KEEP_REL = new Set([path.join('bridge', 'bridge.config.json')])

function assertAssetUrl(url) {
  let parsed
  try { parsed = new URL(String(url || '')) } catch (e) { throw new Error('下载地址不对：' + String(url || '(空)')) }
  const host = parsed.hostname.toLowerCase()
  const ok = parsed.protocol === 'https:' && (ASSET_HOSTS.indexOf(host) >= 0 || host.endsWith('.githubusercontent.com'))
  if (!ok) throw new Error('不从 ' + host + ' 下载：只允许 GitHub 的下载地址')
}

/** 找 release 里该下的那个 zip：先认游戏名，再退到 win64，最后才拿第一个。 */
export function pickAsset(release) {
  const assets = Array.isArray(release?.assets) ? release.assets : []
  const zips = assets.filter(a => a && ZIP_RE.test(String(a.name || '')) && Number(a.size) > 0)
  if (!zips.length) return null
  // 同一个 release 里还挂着 CharacterStudio 的 win64 包（158 MB）和增量补丁包
  // （CabinWorld-1.1-usage-patch-incremental.zip.zip，也叫 CabinWorld 但不带 win64），
  // 所以两个条件都要满足才算游戏包；退路是「带 win64」，最后才拿第一个。
  return zips.find(a => /cabinworld/i.test(String(a.name)) && WIN_RE.test(String(a.name)))
    || zips.find(a => WIN_RE.test(String(a.name)))
    || zips[0]
}

/** 问 GitHub 最新 release；失败抛错，消息可以直接给人看。 */
export async function latestRelease({ timeoutMs = 20000 } = {}) {
  let res
  try {
    res = await fetch(API_LATEST, { headers: { 'user-agent': UA, accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(timeoutMs) })
  } catch (error) {
    const why = error?.name === 'TimeoutError' ? '连接 GitHub 超时' : (error?.message || String(error))
    throw new Error('查最新版本失败：' + why + '（可以手动下载：https://github.com/' + REPO + '/releases/latest）')
  }
  if (res.status === 401) throw new Error('GitHub 返回 401（未授权）。可以手动下载 https://github.com/' + REPO + '/releases/latest 解压到游戏目录。')
  if (res.status === 403) throw new Error('GitHub 接口被限流了（403，同一出口 IP 每小时 60 次）：等一会儿再试，或手动下载 https://github.com/' + REPO + '/releases/latest 解压到游戏目录。')
  if (res.status === 404) throw new Error('仓库或 Release 不存在（404）：' + REPO)
  if (!res.ok) throw new Error('查最新版本失败：HTTP ' + res.status)
  const rel = await res.json()
  const asset = pickAsset(rel)
  if (!asset) throw new Error('这个 release 里没有可下载的 zip：' + (rel?.tag_name || ''))
  return {
    tag: String(rel.tag_name || ''),
    name: String(rel.name || rel.tag_name || ''),
    publishedAt: String(rel.published_at || ''),
    // GitHub 对新 Release 会给 digest（sha256:…）；老 Release 没有，那就退化成不校验。
    asset: { name: String(asset.name), size: Number(asset.size) || 0, url: String(asset.browser_download_url), digest: String(asset.digest || '').indexOf('sha256:') === 0 ? String(asset.digest).slice(7) : '' },
  }
}

/** 跑一个子进程，等到结束；非 0 退出就抛错（带 stderr 尾巴）。 */
function run(file, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { windowsHide: true })
    let out = ''
    let err = ''
    child.stdout?.on('data', d => { out += String(d) })
    child.stderr?.on('data', d => { err += String(d) })
    child.once('error', e => reject(new Error(file + ' 跑不起来：' + e.message)))
    child.once('close', code => {
      if (code === 0) resolve({ out, err })
      else reject(new Error(file + ' 退出码 ' + code + '：' + (err || out || '').slice(-400)))
    })
  })
}

function systemTar() {
  const win = process.env.SystemRoot || 'C:\\Windows'
  const p = path.join(win, 'System32', 'tar.exe')
  return fs.existsSync(p) ? p : 'tar'
}

/** 解压 zip：Windows 自带 tar.exe；条目名越界（.. / 绝对路径）直接报错。 */
export async function unzip(zip, dest) {
  fs.mkdirSync(dest, { recursive: true })
  const listed = await run(systemTar(), ['-tf', zip])
  for (const name of String(listed.out || '').split(/\r?\n/)) {
    const entry = name.trim()
    if (!entry) continue
    if (path.isAbsolute(entry) || /^[a-zA-Z]:/.test(entry) || entry.split(/[\\/]/).indexOf('..') >= 0) throw new Error('压缩包里有越界条目：' + entry)
  }
  await run(systemTar(), ['-xf', zip, '-C', dest])
  return 'tar'
}

/** 压缩包里常带一层同名目录；找到真正放 start.cmd 的那一层。 */
export function pickRoot(dir) {
  if (fs.existsSync(path.join(dir, 'start.cmd'))) return dir
  const items = fs.readdirSync(dir, { withFileTypes: true }).filter(e => !e.name.startsWith('__'))
  for (const e of items) {
    if (!e.isDirectory()) continue
    const sub = path.join(dir, e.name)
    if (fs.existsSync(path.join(sub, 'start.cmd'))) return sub
  }
  return dir
}

/** 只保留 Node 18+ 的提示（游戏要求，桥要跑在 Node 上）。 */
export function nodeTooOld() {
  const major = Number(String(process.versions.node || '0').split('.')[0])
  return { tooOld: !(major >= 18), version: process.versions.node }
}

/** 桥的 data 目录。和 bridgecfg.bridgeDataDir 同义，但那边依赖本文件，import 会成环。 */
function dataDirOf(dir) {
  try {
    const raw = fs.readFileSync(path.join(String(dir).trim(), 'bridge', 'bridge.config.json'), 'utf8').replace(/^\uFEFF/, '')
    return path.resolve(path.join(String(dir).trim(), 'bridge'), String(JSON.parse(raw).dataDir || '../data'))
  } catch (e) {
    return path.join(String(dir).trim(), 'data')
  }
}

/** 装之前先关掉游戏和桥：exe 被占用时覆盖会失败，留下半新半旧的目录。 */
function stopGameAndBridge(dir, log) {
  const stopped = []
  const killPid = function (pid, label) {
    if (!pid) return
    const r = killBridge(pid)
    if (r.killed) stopped.push(label)
    else if (log && r.why) log.info('小屋世界：' + r.why)
  }
  try { killPid(Number(fs.readFileSync(hostPidFile(dir), 'utf8')) || 0, '副本桥') } catch (e) { /* 没有 host.pid */ }
  try { killPid(Number(JSON.parse(fs.readFileSync(path.join(dataDirOf(dir), 'bridge.json'), 'utf8')).pid) || 0, '桥') } catch (e) { /* 没在跑 */ }
  if (isGameRunning(dir)) {
    try { execFileSync('taskkill', ['/IM', assertKillable(exeName(dir)), '/F'], { stdio: 'ignore', timeout: 8000 }); stopped.push('游戏') } catch (e) { /* 关不掉就继续，覆盖时会报错 */ }
  }
  return stopped
}

/** 把解压出来的包放进游戏目录：包里有的一律装，data/backups 和桥配置留着不动。 */
export function copyPackage(root, dir) {
  const copied = []
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    if (KEEP_TOP.has(e.name)) continue
    fs.cpSync(path.join(root, e.name), path.join(dir, e.name), {
      recursive: true, force: true,
      filter: function (src) {
        const rel = path.relative(root, src)
        if (KEEP_REL.has(rel)) return false
        return !KEEP_TOP.has(rel.split(path.sep)[0])
      },
    })
    copied.push(e.name)
  }
  return copied
}

/**
 * 创建一个安装器。状态在内存里，面板轮询 getState()。
 * stages: checking → downloading → unzipping → installing → done / error
 */
export function createInstaller({ gameDir, log = console }) {
  let state = {
    phase: 'idle',
    percent: 0,
    message: '',
    tag: '',
    bytes: 0,
    total: 0,
    at: 0,
    error: '',
    doneAt: 0,
  }
  let running = false

  function set(patch) {
    state = { ...state, ...patch, at: Date.now() }
  }

  function dirNow() {
    const d = String(gameDir() || '').trim()
    if (!d) throw new Error('没设置游戏目录')
    return d
  }

  function isInstalled() {
    try {
      return fs.existsSync(path.join(dirNow(), 'start.cmd')) && fs.existsSync(exePath(dirNow()))
    } catch { return false }
  }

  function getState() {
    return { ...state, running, installed: isInstalled() }
  }

  async function download(url, dest, onTick, expectSha256) {
    assertAssetUrl(url)
    let res
    try {
      res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/octet-stream' }, redirect: 'follow', signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
    } catch (error) {
      throw new Error('下载失败：' + (error?.name === 'TimeoutError' ? '10 分钟没下完，已中止' : (error?.message || String(error))))
    }
    if (!res.ok || !res.body) throw new Error('下载失败：HTTP ' + res.status)
    // redirect: 'follow' 会跟着 3xx 走到别的主机——最终地址必须再验一次，否则「只从 GitHub 下载」只是句空话。
    assertAssetUrl(res.url)
    const total = Number(res.headers.get('content-length') || 0)
    const out = fs.createWriteStream(dest)
    let received = 0
    let last = 0
    const body = Readable.fromWeb(res.body)
    // 计数放进 pipeline 里的 Transform：body 上挂 data 监听会把它切成 flowing，
    // 首批 chunk 可能在 pipe 建立前就被吃掉，落盘比 content-length 短而 pipeline 照样 resolve。
    // 边下边算 sha256：下载的文件要以宿主 Node 的权限跑起来，得能证明它就是 GitHub 上那一个。
    const hash = expectSha256 ? crypto.createHash('sha256') : null
    const counter = new Transform({
      transform(chunk, enc, cb) {
        received += chunk.length
        if (hash) hash.update(chunk)
        const now = Date.now()
        if (now - last > 400) { last = now; onTick(received, total) }
        cb(null, chunk)
      },
    })
    await pipeline(body, counter, out)
    onTick(received, total)
    // pipeline 在「连接正常关闭但字节不够」时照样 resolve：不问一句就会拿半个 zip 去解压。
    if (total > 0 && received !== total) {
      await fsp.rm(dest, { force: true }).catch(() => {})
      throw new Error('下载不完整（收到 ' + (received / 1048576).toFixed(1) + ' MB，应该是 ' + (total / 1048576).toFixed(1) + ' MB），已删掉没装。检查网络后重试。')
    }
    if (hash) {
      const got = hash.digest('hex').toLowerCase()
      if (got !== String(expectSha256).toLowerCase()) {
        await fsp.rm(dest, { force: true }).catch(() => {})
        throw new Error('下载回来的文件和 GitHub 公布的对不上（sha256 不符），已删掉没装。可能是网络被劫持，或上游刚替换了包，重试一次；一直这样就别装了。')
      }
    }
    return { received, total, verified: Boolean(hash) }
  }

  async function install() {
    if (running) return { ok: false, message: '已经在装了，等这次装完。' }
    const node = nodeTooOld()
    if (node.tooOld) return { ok: false, message: '小屋世界要 Node.js 18+，你现在是 ' + node.version + '。' }
    // 内存里的 running 挡不住「装到一半模块被热重载」——新实例的 running 又是 false，
    // 用户以为卡住了再点一次就会两条安装同时写同一个 zip 和同一个游戏目录。
    // 磁盘上留个锁：第二下会被挡住；超过 20 分钟当陈旧锁（进程崩了留下的）。
    const lockFile = path.join(dirNow(), '.installing')
    try {
      if (fs.existsSync(lockFile)) {
        const age = Date.now() - Number(fs.statSync(lockFile).mtimeMs) || 0
        if (age >= 0 && age < 20 * 60 * 1000) return { ok: false, message: '上一次安装还没结束（或刚被中断过）。过几分钟再试，或删掉 ' + lockFile + ' 后重试。' }
      }
      fs.writeFileSync(lockFile, String(Date.now()))
    } catch { /* 锁写不下去就别拦着装了 */ }
    running = true
    // 提在 try 外面：失败时 catch 也要知道装之前是不是关过游戏/桥（关过就得拉回来）。
    let stopped = []
    set({ phase: 'checking', percent: 0, message: '正在查最新版本…', error: '', doneAt: 0 })
    try {
      const dir = dirNow()
      const tmp = path.join(dir, '__download')
      const unpack = path.join(dir, '__unpack')
      fs.mkdirSync(dir, { recursive: true })
      const rel = await latestRelease()
      set({ tag: rel.tag, message: '最新版本 ' + rel.tag + '（' + (rel.asset.size / 1048576).toFixed(1) + ' MB），开始下载…' })
      stopped = stopGameAndBridge(dir, log)
      if (stopped.length) set({ message: '已先关掉' + stopped.join('、') + '，正在下载 ' + rel.tag + '…' })
      await new Promise(function (r) { setTimeout(r, 1500) })
      await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {})
      await fsp.mkdir(tmp, { recursive: true })
      const zip = path.join(tmp, 'CabinWorld.zip')
      set({ phase: 'downloading', percent: 0 })
      // rel.asset.digest 为空（老 Release 没给 digest）时 download 内部会跳过校验。
      const got = await download(rel.asset.url, zip, (received, total) => {
        const pct = total > 0 ? Math.round(received * 100 / total) : 0
        set({ phase: 'downloading', percent: pct, bytes: received, total, message: '正在下载 ' + (received / 1048576).toFixed(1) + ' / ' + (total ? (total / 1048576).toFixed(1) : '?') + ' MB' })
      }, rel.asset.digest)
      set({ phase: 'unzipping', percent: 100, message: '下载完了（' + (got.received / 1048576).toFixed(1) + ' MB）' + (got.verified ? '，sha256 已核对' : '') + '，正在解压…' })
      await fsp.rm(unpack, { recursive: true, force: true }).catch(() => {})
      const how = await unzip(zip, unpack)
      const root = pickRoot(unpack)
      // release 里挑错 asset（比如挑中源码包）时这里会落空：先确认解出来的真是游戏，再往游戏目录铺。
      if (!fs.existsSync(path.join(root, 'start.cmd'))) {
        await fsp.rm(unpack, { recursive: true, force: true }).catch(() => {})
        throw new Error('下载到的不是游戏包（解压后没有 start.cmd）。可能 Release 里挑错了文件，手动下载吧：https://github.com/' + REPO + '/releases/latest')
      }
      set({ phase: 'installing', percent: 100, message: '正在放到 ' + dir + '（保留 data 存档）…' })
      const kept = fs.existsSync(path.join(dir, 'data')) ? 1 : 0
      const copied = copyPackage(root, dir)
      await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {})
      await fsp.rm(unpack, { recursive: true, force: true }).catch(() => {})
      // 装之前关掉的桥和游戏，装完自动拉回来，不用用户自己再点一次。
      let relaunched = ''
      if (stopped.length) {
        try {
          const synced = ensureHost({ gameDir: dir, patchesScript: PATCHES, log: log || console })
          const started = startHost({ gameDir: dir, configPath: path.join(dir, 'bridge', 'bridge.config.json'), log: log || console })
          relaunched = started.ok ? '；已重新打开桥和游戏' : '；启动桥失败：' + started.message
          if (!synced.ok) relaunched += '（副本桥：' + synced.message + '）'
        } catch (error) {
          relaunched = '；自动启动失败：' + (error && error.message ? error.message : error)
        }
      }
      set({ phase: 'done', percent: 100, doneAt: Date.now(), error: '', message: '装好了：' + rel.tag + '（解压方式 ' + how + '）' + (kept ? '；保留了原有 data 存档' : '') + (copied.length ? '；装入 ' + copied.length + ' 项' : '') + relaunched })
      log.info('小屋世界安装完成：' + rel.tag + ' → ' + dir)
      return { ok: true, message: state.message, tag: rel.tag }
    } catch (error) {
      const message = error?.message || String(error)
      // 临时文件必须清：不清的话下次重试要先再下一遍 287 MB 才能清 __unpack，
      // 磁盘紧的时候就成了永远装不上的死循环。
      const d = dirNow()
      await fsp.rm(path.join(d, '__download'), { recursive: true, force: true }).catch(() => {})
      await fsp.rm(path.join(d, '__unpack'), { recursive: true, force: true }).catch(() => {})
      // 安装前关掉的游戏和桥，失败也得拉回来——否则用户会觉得「点了一下安装，游戏没了」。
      let back = ''
      if (stopped.length) {
        try {
          ensureHost({ gameDir: d, patchesScript: PATCHES, log: log || console })
          const again = startHost({ gameDir: d, configPath: path.join(d, 'bridge', 'bridge.config.json'), log: log || console })
          back = again.ok ? '；已把游戏和桥重新打开' : '；重新打开失败：' + again.message
        } catch (e) { back = '；重新打开失败：' + ((e && e.message) || e) }
      }
      const full = message + back
      set({ phase: 'error', error: message, message: '安装失败：' + full })
      log.error('小屋世界安装失败：' + full)
      return { ok: false, message: full }
    } finally {
      running = false
      try { fs.rmSync(lockFile, { force: true }) } catch { /* 删不掉就等它自己过期 */ }
    }
  }

  return { install, getState, isInstalled }
}
