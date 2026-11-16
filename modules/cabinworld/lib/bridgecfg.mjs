// 读写 bridge/bridge.config.json：只改指定键，保留 _说明 和其他字段；写前自动备份。
// 名字要通过重启桥才生效（桥启动时 loadConfig 读一次）。

import fs from 'node:fs'
import path from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { ensureHost, startHost, hostPidFile, killBridge } from './host.mjs'
import { exePath, assertInside } from './exe.mjs'

const PATCHES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'patches', 'apply.mjs')

const FILE_NAME = 'bridge.config.json'

function stripBom(text) {
  const s = String(text || '')
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s
}

export function configPath(gameDir) {
  return assertInside(gameDir, path.join(String(gameDir || '').trim(), 'bridge', FILE_NAME))
}

export function readBridgeConfig(gameDir) {
  const file = configPath(gameDir)
  const raw = fs.readFileSync(file, 'utf8')
  const json = JSON.parse(stripBom(raw))
  return { file, raw, json }
}

export function bridgeConfigInfo(gameDir) {
  const got = readBridgeConfig(gameDir)
  const http = got.json.http || {}
  const weather = got.json.weather || {}
  assertInside(gameDir, path.resolve(path.join(String(gameDir || '').trim(), 'bridge'), String(got.json.gameExe || '../CabinWorld.exe')))
  return {
    file: got.file,
    displayName: String(got.json.displayName || ''),
    hostName: String(got.json.hostName || ''),
    resident: String(got.json.resident || ''),
    port: Number(http.port == null ? 18790 : http.port),
    launchGame: got.json.launchGame !== false,
    weatherMode: String(weather.mode || 'virtual'),
    waitMs: Number(got.json.waitMs == null ? 45000 : got.json.waitMs),
    dataDir: String(got.json.dataDir || '../data'),
    gameExe: String(got.json.gameExe || '../CabinWorld.exe'),
  }
}

// exePath 在 lib/exe.mjs：host.mjs、install.mjs 也要用，放在本文件会成环。

/** 备份只留最近 3 份，别无限堆。 */
function pruneBackups(file) {
  try {
    const dir = path.dirname(file)
    const prefix = path.basename(file) + '.bak-'
    const rows = fs.readdirSync(dir)
      .filter(name => name.startsWith(prefix))
      .map(name => { const full = path.join(dir, name); return { full, mtime: fs.statSync(full).mtimeMs } })
      .sort((a, b) => b.mtime - a.mtime)
    for (const row of rows.slice(3)) fs.rmSync(row.full, { force: true })
  } catch { /* 清理失败不影响写入 */ }
}

export function writeBridgeConfig(gameDir, patch, forget) {
  const got = readBridgeConfig(gameDir)
  const next = JSON.parse(JSON.stringify(got.json))
  const applied = []
  if (patch.displayName !== undefined) { next.displayName = String(patch.displayName); applied.push('displayName') }
  if (patch.hostName !== undefined) { next.hostName = String(patch.hostName); applied.push('hostName') }
  if (patch.launchGame !== undefined) { next.launchGame = patch.launchGame === true; applied.push('launchGame') }
  if (patch.weatherMode !== undefined) {
    next.weather = Object.assign({}, next.weather || {})
    next.weather.mode = patch.weatherMode === 'push' ? 'push' : 'virtual'
    applied.push('weather.mode')
  }
  if (patch.port !== undefined) {
    const p = Number(patch.port)
    if (!Number.isFinite(p) || p < 0 || p > 65535) throw new Error('端口不对：' + patch.port)
    next.http = Object.assign({}, next.http || {})
    next.http.port = Math.round(p)
    applied.push('http.port')
  }
  if (!applied.length) return { file: got.file, backup: '', applied }
  const backup = got.file + '.bak-' + Date.now()
  fs.copyFileSync(got.file, backup)
  const tmp = got.file + '.tmp-' + Date.now()
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8')
  fs.renameSync(tmp, got.file)
  pruneBackups(got.file)
  if (typeof forget === 'function') { try { forget() } catch { /* 缓存清不掉不影响写入 */ } }
  return { file: got.file, backup, applied }
}

/** 桥的 data 目录（相对 bridge 文件夹）。 */
export function bridgeDataDir(gameDir) {
  const info = bridgeConfigInfo(gameDir)
  return assertInside(gameDir, path.resolve(path.join(String(gameDir).trim(), 'bridge'), info.dataDir || '../data'))
}

function pidAlive(pid) {
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', '(Get-Process -Id ' + Number(pid) + ' -ErrorAction SilentlyContinue).Id'], { encoding: 'utf8', timeout: 10000 })
    return String(out).trim() !== ''
  } catch { return false }
}

/** 重启桥：按 bridge.json 里的 pid 关掉旧的，同步宿主副本（bridge-host），再用副本启动。 */
export async function restartBridge({ gameDir, dataDir, log, forget }) {
  const dir = String(gameDir || '').trim()
  const bridgeJson = path.join(String(dataDir || '').trim(), 'bridge.json')
  let pid = 0
  try { pid = Number(JSON.parse(stripBom(fs.readFileSync(bridgeJson, 'utf8'))).pid) || 0 } catch { /* 没有 bridge.json 就是没有旧桥 */ }
  // 先停自己的副本桥（host.pid）、再停 bridge.json 里那座（可能是官方 start.cmd 起的）。
  // 只按命令行确认身份后才动手：副本桥是插件宿主 spawn 出来的，按父进程杀会把机器人本体一起杀掉。
  let hostPid = 0
  try { hostPid = Number(fs.readFileSync(hostPidFile(dir), 'utf8')) || 0 } catch { /* 没有 host.pid */ }
  const tried = []
  for (const p of [hostPid, pid]) {
    if (!p || tried.indexOf(p) >= 0) continue
    tried.push(p)
    const stopped = killBridge(p)
    if (log) log.info(stopped.killed ? '小屋世界：已停掉' + stopped.why + '（pid ' + p + '）' : '小屋世界：' + stopped.why)
  }
  if (tried.length) {
    await new Promise(function (r) { setTimeout(r, 2500) })
    if (pid > 0 && pidAlive(pid)) return { ok: false, message: '旧的桥进程 ' + pid + ' 关不掉，所以没有起新的桥：去任务管理器结束它再试一次。' }
  }
  let exe = ''
  try { exe = exePath(dir) } catch (e) { return { ok: false, message: '读不到桥配置里的游戏 exe：' + String((e && e.message) || e) } }
  // 这几条都是"能预期到的失败"，统一用 {ok,message} 返回：三个调用方都按返回值处理，
  // throw 出来会变成未捕获异常（/小屋 启动 只回一句空话，面板 500）。
  if (!fs.existsSync(exe)) return { ok: false, message: '找不到 ' + exe + '：先一键安装' }
  const synced = ensureHost({ gameDir: dir, patchesScript: PATCHES, log: log || console })
  if (!synced.ok) return { ok: false, message: synced.message }
  // 补丁没打上：桥能跑，但 sleep / toolpose 这两个工具不存在。
  if ((synced.degraded || synced.patched === false) && log && log.warn) log.warn('小屋世界：' + String(synced.message || '补丁没打上'))
  const started = startHost({ gameDir: dir, configPath: configPath(dir), log: log || console })
  if (!started.ok) return { ok: false, message: started.message }
  const deadline = Date.now() + 25000
  let last = null
  while (Date.now() < deadline) {
    await new Promise(function (r) { setTimeout(r, 1500) })
    try {
      const info = JSON.parse(stripBom(fs.readFileSync(bridgeJson, 'utf8')))
      const url = String(info.url || '')
      if (!url) continue
      const res = await fetch(url + '/v1/health', { signal: AbortSignal.timeout(3000) })
      const body = await res.json()
      last = body
      if (body && body.ok === true) {
        if (typeof forget === 'function') { try { forget() } catch { /* 缓存清不掉不影响重启 */ } }
        return { ok: true, url: url, game: body.game === true }
      }
    } catch { /* 还在起 */ }
  }
  return { ok: false, message: '桥重启后 25 秒内没连上' + (last ? '（最后一次：' + JSON.stringify(last) + '）' : '') + '：看 bridge-host/host.log 末尾有没有报错，或端口被占。' }
}
