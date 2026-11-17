// screen.mjs —— 共享屏幕（按主人指令把画面定时发到 QQ）
// 来源：aurabot 模块库 modules/windows-ops（本仓库原创，MIT）
// 作用：一条「会话」把 screen.capture 的 JPEG 帧按间隔发到指定聊天（只允许主人私聊，
//       由入口层校验）。不依赖关掉面板就断：总开关关掉、键鼠闸门都照旧管着——这里只碰屏幕。
// 契约：export function createScreenShare({ ops, sendImage, dataDir, getSettings, log?, now?, readFile?, onEnd? })
//   → { start({chatId, minutes}) , stop(reason), tick() , status(), settings() }
//   tick() 由入口层的 api.every 每秒调一次；返回 { acted, active, skipped?, error?, ended? }
// 设计要点：
//   · 去重：画面没变（JPEG md5 相同）就不重复发，最多 60 秒补一张心跳帧，省流量也省主人的眼睛；
//   · 限时：默认 10 分钟，最长 120 分钟，到点自动停并在会话聊天里说一声（onEnd 回调）；
//   · 失败：连续 3 次截屏/发图失败就自动停（网关断线、PowerShell 起不来时不会无限刷日志）；
//   · 落盘：帧文件统一在 dataDir()/shots，只保留最近 80 张、且老于 60 秒的才删（避免删到正在读的那张）。
import { readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

const MIN_INTERVAL_SEC = 2
const MAX_INTERVAL_SEC = 300
const HEARTBEAT_MS = 60_000
const MAX_CONSECUTIVE_FAIL = 3
const KEEP_FRAMES = 80

/** 读设置里的共享参数（每次现读，面板改完下一条指令就生效）。 */
function readConf(getSettings) {
  const s = getSettings() || {}
  const num = (v, d, min, max) => {
    const n = Number(v)
    return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : d
  }
  return {
    intervalSec: num(s.shareInterval, 5, MIN_INTERVAL_SEC, MAX_INTERVAL_SEC),
    quality: num(s.shareQuality, 60, 20, 95),
    maxWidth: num(s.shareMaxWidth, 1280, 320, 3840),
    minutes: num(s.shareMinutes, 10, 1, 120),
  }
}

export function createScreenShare({ ops, sendImage, dataDir, getSettings, log = {}, now = () => Date.now(), readFile = readFileSync, onEnd = null } = {}) {
  let session = null // 同时只允许一条共享会话
  let lastHash = ''
  let lastSentAt = 0
  let lastError = ''
  let consecutiveFail = 0

  const shotsDir = () => join(dataDir, 'shots')
  const settings = () => readConf(getSettings)

  /** 只保留最近 KEEP_FRAMES 张、且落盘超过 60 秒的帧（正在读的那张不会被删）。 */
  function prune() {
    try {
      const names = readdirSync(shotsDir()).filter((n) => /^(frame|shot)-[^\s]+\.jpg$/.test(n))
      if (names.length <= KEEP_FRAMES) return
      const files = names
        .map((n) => ({ n, t: statSync(join(shotsDir(), n)).mtimeMs }))
        .sort((a, b) => b.t - a.t)
      for (const f of files.slice(KEEP_FRAMES)) {
        if (now() - f.t > 60_000) { try { unlinkSync(join(shotsDir(), f.n)) } catch { /* 删不掉就算了 */ } }
      }
    } catch { /* 数据目录还没建/权限问题：不影响发图 */ }
  }

  /** 结束会话（正常到点、主人停止、连续失败都走这里）。 */
  function finish(reason) {
    if (!session) return { acted: false, active: false }
    const done = {
      chatId: session.chatId,
      startedAt: session.startedAt,
      sent: session.sent,
      skipped: session.skipped,
      errors: session.errors,
      bytes: session.bytes,
      reason,
    }
    session = null
    lastHash = ''
    lastSentAt = 0
    consecutiveFail = 0
    try { onEnd?.(done) } catch (e) { log.warn?.('共享结束回调出错：', e?.message || e) }
    log.info?.(`[共享屏幕] 结束（${reason}）：发了 ${done.sent} 张，跳过 ${done.skipped} 帧`)
    return { acted: false, active: false, ended: reason, sent: done.sent }
  }

  /** 失败计数：连续 3 次就自动停，错误留在 status 里。 */
  function fail(message) {
    lastError = String(message || '未知错误').slice(0, 200)
    session.errors++
    consecutiveFail++
    log.warn?.(`[共享屏幕] 出错（第 ${consecutiveFail} 次）：${lastError}`)
    if (consecutiveFail >= MAX_CONSECUTIVE_FAIL) return finish(`连续 ${MAX_CONSECUTIVE_FAIL} 次失败：${lastError}`)
    return { acted: false, active: true, error: lastError }
  }

  /**
   * 开始共享。
   * @param {{chatId?: string, minutes?: number}} o chatId 必须是 private:xxx（入口层校验）；
   *   minutes 覆盖设置里的默认时长（1~120 分钟）。
   */
  function start({ chatId, minutes } = {}) {
    const c = settings()
    if (!chatId) return { ok: false, message: '没指定发到哪个聊天（共享只往主人私聊发）' }
    if (session) {
      return { ok: false, message: `已经在共享了（发往 ${session.chatId}，还剩 ${Math.max(0, Math.ceil((session.until - now()) / 60000))} 分钟）。要重来先发 /wops share stop` }
    }
    const mins = Number.isFinite(Number(minutes)) && Number(minutes) > 0
      ? Math.min(120, Math.max(1, Math.round(Number(minutes))))
      : c.minutes
    const t = now()
    session = {
      chatId: String(chatId),
      startedAt: t,
      until: t + mins * 60_000,
      intervalMs: c.intervalSec * 1000,
      minutes: mins,
      sent: 0,
      skipped: 0,
      errors: 0,
      bytes: 0,
      lastFrameAt: 0,
    }
    lastHash = ''
    lastSentAt = 0
    consecutiveFail = 0
    lastError = ''
    log.info?.(`[共享屏幕] 开始：每 ${c.intervalSec} 秒一帧，最多 ${mins} 分钟 → ${chatId}`)
    return {
      ok: true,
      message: `开始共享屏幕：每 ${c.intervalSec} 秒一帧（${c.maxWidth}px / JPEG ${c.quality}），最多 ${mins} 分钟，发到这个聊天`,
      session: { chatId: session.chatId, until: session.until, intervalSec: c.intervalSec, minutes: mins },
    }
  }

  /** 主人停止。 */
  function stop(reason = '主人停止') {
    if (!session) return { ok: false, message: '现在没有在共享屏幕' }
    const r = finish(reason)
    return { ok: true, message: `已停止共享屏幕（本次共发 ${r.sent || 0} 张）`, sent: r.sent || 0 }
  }

  /** 由入口层的 api.every(1000) 调：到点才截一帧、发一张。 */
  async function tick() {
    if (!session) return { acted: false, active: false }
    const t = now()
    // 主人关掉总开关 = 收工：不让共享继续在后台发画面
    if (getSettings()?.enabled === false) return finish('总开关已关，自动停止共享')
    if (t >= session.until) return finish(`到点了（${session.minutes} 分钟），自动停止共享`)
    if (t - session.lastFrameAt < session.intervalMs) return { acted: false, active: true }
    session.lastFrameAt = t

    let cap
    try {
      cap = await ops.run('screen.capture', { maxWidth: settings().maxWidth, quality: settings().quality })
    } catch (e) {
      return fail(`截屏失败：${e?.message || e}`)
    }
    if (!cap?.ok || !cap?.data?.file) return fail(`截屏失败：${cap?.message || '没有拿到帧文件'}`)

    let buf
    try { buf = readFile(cap.data.file) } catch (e) { return fail(`读帧失败：${e?.message || e}`) }
    if (!buf || !buf.length) return fail('帧是空的')

    const hash = createHash('md5').update(buf).digest('hex')
    // 画面没变就不重发；但最多 60 秒补一张，让主人知道还连着
    if (hash === lastHash && t - lastSentAt < HEARTBEAT_MS) {
      session.skipped++
      prune()
      return { acted: false, active: true, skipped: true }
    }

    try {
      const sent = await sendImage(session.chatId, 'base64://' + Buffer.from(buf).toString('base64'))
      if (!sent) return fail('发图没成功（可能总开关/试运行拦下了，或网关没连上）')
    } catch (e) {
      return fail(`发图失败：${e?.message || e}`)
    }

    lastHash = hash
    lastSentAt = t
    session.sent++
    session.bytes += buf.length
    consecutiveFail = 0
    lastError = ''
    prune()
    log.debug?.(`[共享屏幕] 第 ${session.sent} 帧已发（${Math.round(buf.length / 1024)}KB）`)
    return { acted: true, active: true, sent: session.sent, bytes: buf.length }
  }

  /** 状态（QQ 命令 / 面板 / 工具共用）。 */
  function status() {
    const c = settings()
    if (!session) {
      return { active: false, settings: c, lastError }
    }
    return {
      active: true,
      chatId: session.chatId,
      startedAt: session.startedAt,
      until: session.until,
      remainingMs: Math.max(0, session.until - now()),
      intervalSec: Math.round(session.intervalMs / 1000),
      minutes: session.minutes,
      sent: session.sent,
      skipped: session.skipped,
      errors: session.errors,
      bytes: session.bytes,
      lastError,
      settings: c,
    }
  }

  return { start, stop, tick, status, settings }
}
