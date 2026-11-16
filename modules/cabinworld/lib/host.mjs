// 宿主副本：把官方 bridge 复制一份、打上「睡觉」「工具姿势」两类高级协议补丁，跑这份副本。
// 官方 bridge/ 永远保持原样（一键安装/升级随便覆盖），副本在 <游戏目录>/bridge-host/。
// 副本与 bridge/ 是兄弟目录，配置里的 ../data、../CabinWorld.exe 相对路径照样成立。

import fs from 'node:fs'
import path from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { exeName } from './exe.mjs'

export const HOST_DIR = 'bridge-host'
const STAMP_FILE = '.source-stamp'
const PATCHED_FILE = '.patched'   // 1 = 已打高级协议补丁，0 = 官方桥原样兜底
const PID_FILE = 'host.pid'

export function sourceDir(gameDir) { return path.join(String(gameDir || '').trim(), 'bridge') }
export function hostDir(gameDir) { return path.join(String(gameDir || '').trim(), HOST_DIR) }
export function hostPidFile(gameDir) { return path.join(hostDir(gameDir), PID_FILE) }

function statOf(file) {
  try { const s = fs.statSync(file); return String(Math.round(s.mtimeMs)) + ':' + String(s.size) } catch { return '-' }
}

/** 整个目录的指纹（相对路径 + 大小 + mtime），给补丁目录用。 */
function treeStamp(dir) {
  const rows = []
  function walk(base, rel) {
    let list = []
    try { list = fs.readdirSync(base, { withFileTypes: true }) } catch { return }
    for (const e of list) {
      const full = path.join(base, e.name), relPath = rel ? rel + '/' + e.name : e.name
      // data/ 是桥的运行时数据（每次启动都写），日志和备份也不该参与指纹。
      if (e.isDirectory()) {
        if (e.name === 'data' || e.name === 'node_modules' || e.name === '.git') continue
        walk(full, relPath)
      } else if (e.isFile()) {
        // bridge.config.json 是模块自己会写的（改名、端口、天气），不能算上游变更，
        // 否则每次改名都会触发一次没必要的副本重建。
        if (e.name === 'bridge.config.json') continue
        if (e.name.indexOf('.bak-') >= 0 || /\.log$/.test(e.name)) continue
        rows.push(relPath + '=' + statOf(full))
      }
    }
  }
  walk(dir, '')
  return rows.sort().join(',')
}

/**
 * 官方桥 + 补丁自己的指纹：任一边改了都要重建副本。
 * 只认桥的话，改了 lib/patches/files 里的实现副本不会更新。
 */
export function sourceStamp(gameDir, patchesScript) {
  // 整树指纹：官方桥 lib/ 下任何一个模块变了都要重建，否则用户以为更新了其实还在跑旧代码。
  const parts = ['bridge=' + treeStamp(sourceDir(gameDir))]
  if (patchesScript) parts.push('patches=' + treeStamp(path.dirname(patchesScript)))
  return parts.join('|')
}

export function hostStamp(gameDir) {
  try { return fs.readFileSync(path.join(hostDir(gameDir), STAMP_FILE), 'utf8').trim() } catch { return '' }
}

export function isInstalled(gameDir) {
  return fs.existsSync(path.join(sourceDir(gameDir), 'bridge.mjs'))
}

/** 副本是不是打好补丁的（官方桥原样兜底时为 false）。 */
export function hostPatched(gameDir) {
  try { return fs.readFileSync(path.join(hostDir(gameDir), PATCHED_FILE), 'utf8').trim() === '1' } catch { return false }
}

export function needsSync(gameDir, patchesScript) {
  if (!fs.existsSync(path.join(hostDir(gameDir), 'bridge.mjs'))) return true
  return hostStamp(gameDir) !== sourceStamp(gameDir, patchesScript)
}

// ---- 进程身份：只按命令行认桥，绝不按“父进程”猜（副本桥是插件宿主 spawn 出来的，
//      按父进程杀会杀掉机器人自己）。 ----------------------------------------------------
export function commandLineOf(pid) {
  const n = Number(pid) || 0
  if (!n) return ''
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', '(Get-CimInstance Win32_Process -Filter "ProcessId=' + n + '").CommandLine'], { encoding: 'utf8', timeout: 10000, windowsHide: true })
    return String(out || '').trim()
  } catch { return '' }
}

/** 只杀确认是小屋世界桥的进程（副本桥或官方桥），别的一律不动。 */
export function killBridge(pid) {
  const n = Number(pid) || 0
  if (!n) return { killed: false, why: '没有 pid' }
  const cmd = commandLineOf(n)
  if (!cmd) return { killed: false, why: '进程 ' + n + ' 已经不在了' }
  const host = /bridge-host/i.test(cmd) && /bridge[.]mjs/i.test(cmd)
  const official = !host && /[\\/]bridge[\\/]bridge[.]mjs/i.test(cmd)
  if (!host && !official) return { killed: false, why: '进程 ' + n + ' 不是小屋世界的桥，没动它' }
  try {
    execFileSync('taskkill', ['/PID', String(n), '/F'], { stdio: 'ignore', timeout: 8000, windowsHide: true })
    return { killed: true, why: host ? '副本桥' : '官方桥' }
  } catch { return { killed: false, why: '关不掉进程 ' + n } }
}

/** 游戏窗口还在跑吗？（桥挂了游戏能自己活着，别让新桥再开一个） */
export function isGameRunning(gameDir) {
  try {
    const name = exeName(gameDir)
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq ' + name, '/NH'], { encoding: 'utf8', timeout: 8000, windowsHide: true })
    return out.toLowerCase().indexOf(name.toLowerCase()) >= 0
  } catch { return false }
}

function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true })
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (/[.]bak-/.test(e.name) || e.name === STAMP_FILE || e.name === PID_FILE) continue
    const src = path.join(from, e.name), dst = path.join(to, e.name)
    if (e.isDirectory()) copyTree(src, dst)
    else if (e.isFile()) fs.copyFileSync(src, dst)
  }
}

function noteSync(gameDir, text) {
  try { fs.appendFileSync(path.join(hostDir(gameDir), 'sync.log'), '[' + new Date().toISOString() + '] ' + text + '\n') } catch { /* 日志写不进不影响结论 */ }
}

/** 重建并打补丁。先建在 .new，成功才换上去；失败时旧副本原样保留。 */
function doSync({ gameDir, patchesScript, log }) {
  const src = sourceDir(gameDir), dst = hostDir(gameDir), tmp = dst + '.new', old = dst + '.old'
  if (!fs.existsSync(path.join(src, 'bridge.mjs'))) return { ok: false, rebuilt: false, message: '找不到官方桥：' + src + '（先用 /小屋 安装）' }
  try {
    fs.rmSync(tmp, { recursive: true, force: true })
    fs.rmSync(old, { recursive: true, force: true })
    copyTree(src, tmp)
    execFileSync(process.execPath, [patchesScript, '--game', String(gameDir).trim(), '--bridge', tmp, '--no-backup'], { stdio: 'pipe', timeout: 120000 })
    fs.writeFileSync(path.join(tmp, STAMP_FILE), sourceStamp(gameDir, patchesScript) + '\n')
    fs.writeFileSync(path.join(tmp, PATCHED_FILE), '1\n')
    let movedOld = false
    if (fs.existsSync(dst)) { fs.renameSync(dst, old); movedOld = true }
    try { fs.renameSync(tmp, dst) } catch (e) {
      if (movedOld && !fs.existsSync(dst)) { try { fs.renameSync(old, dst) } catch { /* 回滚失败下面会报 */ } }
      throw e
    }
    if (movedOld) { try { fs.rmSync(old, { recursive: true, force: true }) } catch { /* 残留 .old 不影响运行 */ } }
    log.info && log.info('小屋世界宿主副本已更新：' + dst)
    return { ok: true, rebuilt: true, message: '宿主副本已更新' }
  } catch (error) {
    fs.rmSync(tmp, { recursive: true, force: true })
    // 换目录时出事就把旧副本放回原位；dst 还在就只清残留。
    if (!fs.existsSync(dst) && fs.existsSync(old)) { try { fs.renameSync(old, dst) } catch { /* 见下面的 ok 判断 */ } }
    if (fs.existsSync(dst)) { try { fs.rmSync(old, { recursive: true, force: true }) } catch { /* 忽略 */ } }
    const raw = String((error && (error.stdout || error.stderr || error.message)) || '').trim()
    const tail = raw.slice(-600)
    const status = error && error.status
    const why = status === 2 ? '官方桥代码变了，补丁锚点对不上' : status === 3 ? '补丁后的代码语法没过' : '重建副本失败'
    noteSync(gameDir, why + '（退出码 ' + String(status == null ? '?' : status) + '）：' + tail)
    const alive = fs.existsSync(path.join(dst, 'bridge.mjs'))
    const msg = why + '：' + (tail || '（没有更多输出，详见 bridge-host/sync.log）') + (alive ? '。已继续用旧副本' : '。')
    if (log.error) log.error('小屋世界：' + msg)
    if (alive) return { ok: true, rebuilt: false, degraded: true, patched: hostPatched(gameDir), message: msg }
    // 补丁打不上又没有旧副本：用官方桥原样顶住，至少让小屋世界能用。
    try {
      copyTree(src, tmp)
      fs.writeFileSync(path.join(tmp, STAMP_FILE), sourceStamp(gameDir, patchesScript) + '\n')
      fs.writeFileSync(path.join(tmp, PATCHED_FILE), '0\n')
      fs.renameSync(tmp, dst)
      noteSync(gameDir, '补丁打不上，已改用未打补丁的官方桥副本')
      return { ok: true, rebuilt: true, patched: false, message: msg + '（已先用官方桥原样跑起来，高级协议补丁暂时没有）' }
    } catch (e2) {
      fs.rmSync(tmp, { recursive: true, force: true })
      return { ok: false, rebuilt: false, message: msg }
    }
  }
}

let syncing = false

/** 需要时重建副本（指纹没变就跳过）。同步执行，靠 syncing 标志互斥。 */
export function ensureHost({ gameDir, patchesScript, log = console }) {
  if (!isInstalled(gameDir)) return { ok: false, rebuilt: false, message: '小屋世界还没装：' + String(gameDir || '') }
  if (!needsSync(gameDir, patchesScript)) return { ok: true, rebuilt: false, message: '宿主副本是最新的' }
  if (syncing) return { ok: false, rebuilt: false, busy: true, message: '宿主副本正在更新，稍后再试' }
  syncing = true
  try { return doSync({ gameDir, patchesScript, log }) } finally { syncing = false }
}

/** 启动副本桥（独立进程，日志写 bridge-host/host.log）。游戏已经在跑就不再让它开第二个。 */
export function startHost({ gameDir, configPath, log = console, launchGame = true }) {
  const dir = hostDir(gameDir)
  const entry = path.join(dir, 'bridge.mjs')
  if (!fs.existsSync(entry)) return { ok: false, message: '宿主副本还没准备好：' + entry }
  if (!fs.existsSync(configPath)) return { ok: false, message: '桥配置不存在：' + configPath }
  // 必须传 gameDir：exeName 要按配置里的 gameExe 查，漏传会退回默认的 CabinWorld.exe，
  // 用户自定义过 exe 名时就会以为游戏没开、再拉起第二个实例。
  const wantGame = launchGame !== false && !isGameRunning(gameDir)
  const args = [entry, '--config', configPath]
  if (!wantGame) args.push('--no-launch')
  const logFile = path.join(dir, 'host.log')
  const out = fs.openSync(logFile, 'a')
  let child
  try {
    child = spawn(process.execPath, args, { cwd: String(gameDir).trim(), detached: true, stdio: ['ignore', out, out], windowsHide: true })
  } finally {
    try { fs.closeSync(out) } catch { /* 子进程已经继承句柄 */ }
  }
  // spawn 失败是异步 emit('error')：不挂监听会变成未捕获异常，把整个插件宿主带走
  // （install.mjs 起 tar、index.mjs 起游戏都挂了监听，只有这里漏了）。
  child.once('error', function (e) {
    try { fs.rmSync(hostPidFile(gameDir), { force: true }) } catch { /* 删不掉也不影响 */ }
    try { log.error('副本桥启动失败：' + ((e && e.message) || e)) } catch { /* log 也可能是坏的 */ }
  })
  if (child.pid == null) return { ok: false, message: '副本桥没能启动（可能被杀毒软件拦了，看 bridge-host/host.log）' }
  child.unref()
  try { fs.writeFileSync(hostPidFile(gameDir), String(child.pid)) } catch { /* pid 文件只是方便排查 */ }
  return { ok: true, pid: child.pid, launchedGame: wantGame, message: '副本桥已启动（pid ' + child.pid + '）', logFile: logFile }
}
