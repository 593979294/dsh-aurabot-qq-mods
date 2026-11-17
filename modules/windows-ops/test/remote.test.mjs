// remote.test.mjs —— 远程协助通道（lib/remote.mjs）单元测试
// 来源：aurabot 模块库 modules/windows-ops（MIT）。真起一个 127.0.0.1 的临时端口，
// 用 fake ops 模拟截屏与键鼠（不碰真屏幕），覆盖：开关、邀请、页面、画面、点击换算、
// 键鼠开关、错令牌、关闭释放端口、过期自动关。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRemoteAssist } from '../lib/remote.mjs'

const DATA = mkdtempSync(join(tmpdir(), 'wops-remote-'))
mkdirSync(join(DATA, 'shots'), { recursive: true })
const RECT = { x: 0, y: 0, width: 1920, height: 1080, scaledWidth: 1280, scaledHeight: 720 }

/** fake ops：截屏写一份假 JPEG；键鼠动作只记账。 */
function fakeOps() {
  const calls = []
  let n = 0
  return {
    calls,
    async run(op, args) {
      calls.push({ op, args })
      if (op === 'screen.capture') {
        const file = join(DATA, 'shots', `frame-remote-${++n}.jpg`)
        writeFileSync(file, Buffer.from([0xff, 0xd8, 0xff, 0xd9])) // 最小 JPEG 头尾，只验传输
        return { ok: true, message: 'ok', data: { file, ...RECT } }
      }
      if (op === 'screen.info') return { ok: true, message: 'ok', data: RECT }
      return { ok: true, message: 'ok' }
    },
  }
}

function make({ patch = {}, ops = fakeOps(), t = { v: 10_000 } } = {}) {
  const settings = {
    enabled: true,
    remoteAllow: true,
    remoteBind: '127.0.0.1',
    remotePort: 17890,
    remoteMinutes: 15,
    remoteMaxWidth: 1280,
    remoteQuality: 55,
    allowInput: true,
    ...patch,
  }
  const remote = createRemoteAssist({
    ops,
    dataDir: DATA,
    getSettings: () => settings,
    lanIp: () => '127.0.0.1',
    now: () => t.v,
    log: {},
  })
  return { remote, ops, t, settings }
}

test('总开关关着：invite 直接拒绝，端口不起', async () => {
  const { remote } = make({ patch: { remoteAllow: false } })
  const r = await remote.invite({ port: 0 })
  assert.equal(r.ok, false)
  assert.match(r.message, /远程协助没开/)
  assert.equal(remote.status().active, false)
  remote.dispose()
})

test('邀请成功：链接带 10 位令牌；页面、画面、状态都能取到', async () => {
  const { remote, ops } = make()
  const r = await remote.invite({ port: 0, minutes: 15 })
  assert.equal(r.ok, true)
  assert.match(r.token, /^[a-f0-9]{10}$/)
  assert.equal(r.url, `http://127.0.0.1:${r.port}/r/${r.token}`)

  const page = await fetch(`http://127.0.0.1:${r.port}/r/${r.token}`)
  assert.equal(page.status, 200)
  const html = await page.text()
  assert.match(html, /远程协助/)
  assert.ok(html.includes(`/r/${r.token}`))
  assert.ok(html.includes("BASE + '/frame?n='"))

  const frame = await fetch(`http://127.0.0.1:${r.port}/r/${r.token}/frame`)
  assert.equal(frame.status, 200)
  assert.equal(frame.headers.get('content-type'), 'image/jpeg')
  const bytes = Buffer.from(await frame.arrayBuffer())
  assert.equal(bytes[0], 0xff)
  assert.ok(ops.calls.some((c) => c.op === 'screen.capture'))

  const state = await (await fetch(`http://127.0.0.1:${r.port}/r/${r.token}/state`)).json()
  assert.equal(state.ok, true)
  assert.equal(state.allowInput, true)
  remote.dispose()
})

test('远端点击：归一化坐标换算成虚拟屏幕像素（1920×1080）', async () => {
  const { remote, ops } = make()
  const r = await remote.invite({ port: 0 })
  // 先拉一帧，让模块拿到屏幕矩形
  await (await fetch(`http://127.0.0.1:${r.port}/r/${r.token}/frame`)).arrayBuffer()
  const res = await fetch(`http://127.0.0.1:${r.port}/r/${r.token}/input`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'click', nx: 500, ny: 500, button: 'right' }),
  })
  assert.equal(res.status, 200)
  assert.equal((await res.json()).ok, true)
  const click = ops.calls.find((c) => c.op === 'mouse.click')
  assert.deepEqual(click.args, { x: 960, y: 540, button: 'right' })
  remote.dispose()
})

test('文字输入走剪贴板 + 粘贴（绕开中文输入法）', async () => {
  const { remote, ops } = make()
  const r = await remote.invite({ port: 0 })
  await (await fetch(`http://127.0.0.1:${r.port}/r/${r.token}/frame`)).arrayBuffer()
  const res = await fetch(`http://127.0.0.1:${r.port}/r/${r.token}/input`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'text', text: '你好，世界' }),
  })
  assert.equal((await res.json()).ok, true)
  assert.ok(ops.calls.some((c) => c.op === 'clipboard.write' && c.args.text === '你好，世界'))
  assert.ok(ops.calls.some((c) => c.op === 'paste'))
  remote.dispose()
})

test('键盘没开：只能看，/input 返回 403', async () => {
  const { remote } = make({ patch: { allowInput: false } })
  const r = await remote.invite({ port: 0 })
  const res = await fetch(`http://127.0.0.1:${r.port}/r/${r.token}/input`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'click', nx: 100, ny: 100 }),
  })
  assert.equal(res.status, 403)
  assert.match((await res.json()).error, /允许键鼠模拟/)
  remote.dispose()
})

test('错令牌一律 404（不泄露通道是否存在）', async () => {
  const { remote } = make()
  const r = await remote.invite({ port: 0 })
  const res = await fetch(`http://127.0.0.1:${r.port}/r/0000000000`)
  assert.equal(res.status, 404)
  remote.dispose()
})

test('停止：响应先落地，随后释放端口，status 回 inactive', async () => {
  const { remote } = make()
  const r = await remote.invite({ port: 0 })
  const res = await fetch(`http://127.0.0.1:${r.port}/r/${r.token}/stop`, { method: 'POST' })
  assert.equal((await res.json()).ok, true)
  await new Promise((ok) => setTimeout(ok, 50))
  assert.equal(remote.status().active, false)
  await assert.rejects(fetch(`http://127.0.0.1:${r.port}/r/${r.token}`))
  remote.dispose()
})

test('过期：页面返回 410，并自动关服务', async () => {
  const { remote, t } = make()
  const r = await remote.invite({ port: 0, minutes: 1 })
  t.v += 61_000
  const res = await fetch(`http://127.0.0.1:${r.port}/r/${r.token}`)
  assert.equal(res.status, 410)
  await new Promise((ok) => setTimeout(ok, 50))
  assert.equal(remote.status().active, false)
  remote.dispose()
})
