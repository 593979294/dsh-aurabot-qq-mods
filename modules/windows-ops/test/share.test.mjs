// share.test.mjs —— 共享屏幕会话（lib/screen.mjs）单元测试
// 来源：aurabot 模块库 modules/windows-ops（MIT）。注入 fake ops / fake sendImage / 可控时钟，
// 覆盖：开始与停止、按间隔节流、相同画面去重 + 心跳、失败三次自动停、到点自动停。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createScreenShare } from '../lib/screen.mjs'

const DATA = mkdtempSync(join(tmpdir(), 'wops-share-'))
mkdirSync(join(DATA, 'shots'), { recursive: true })

/** 造一个会「截图」的 fake ops：每次换一份内容（除了 dup 模式），返回文件路径与屏幕矩形。 */
function fakeOps() {
  const calls = []
  let n = 0
  return {
    calls,
    async run(op, args) {
      calls.push({ op, args })
      if (op !== 'screen.capture') return { ok: false, message: '不认识的测试操作' }
      const file = join(DATA, 'shots', `frame-test-${++n}.jpg`)
      writeFileSync(file, Buffer.from('jpeg-' + n)) // 内容不同 → 默认不触发去重
      return { ok: true, message: 'ok', data: { file, x: 0, y: 0, width: 1920, height: 1080, scaledWidth: 1280, scaledHeight: 720 } }
    },
  }
}

function conf(patch = {}) {
  return {
    enabled: true,
    shareInterval: 5,
    shareQuality: 60,
    shareMaxWidth: 1280,
    shareMinutes: 10,
    ...patch,
  }
}

function make({ ops = fakeOps(), patch = {}, t = { v: 1_000_000 } } = {}) {
  const sent = []
  const ends = []
  const live = { enabled: true } // 可变的「总开关」，测试里关掉它验证自动停
  const share = createScreenShare({
    ops,
    dataDir: DATA,
    getSettings: () => conf({ ...patch, enabled: live.enabled }),
    sendImage: async (chatId, src) => { sent.push({ chatId, src }); return { ok: true } },
    now: () => t.v,
    onEnd: (d) => ends.push(d),
    log: {},
  })
  return { share, sent, ends, t, live }
}

test('开始共享：只接受有 chatId 的会话，重复开始会被拒', () => {
  const { share } = make()
  const r1 = share.start({ chatId: 'private:10001' })
  assert.equal(r1.ok, true)
  assert.match(r1.message, /每 5 秒/)
  const r2 = share.start({ chatId: 'private:10002' })
  assert.equal(r2.ok, false)
  assert.match(r2.message, /已经在共享/)
  const r3 = share.start({})
  assert.equal(r3.ok, false)
})

test('按间隔节流：同一间隔内不再截帧；到点才发一张 base64 图', async () => {
  const { share, sent, t } = make()
  share.start({ chatId: 'private:10001' })
  const a = await share.tick()
  assert.equal(a.acted, true)
  assert.equal(sent.length, 1)
  assert.match(sent[0].src, /^base64:\/\//)
  assert.equal(sent[0].chatId, 'private:10001')
  const b = await share.tick() // 同一个 1 秒内、间隔 5 秒没到
  assert.equal(b.acted, false)
  assert.equal(sent.length, 1)
  t.v += 5_000
  const c = await share.tick()
  assert.equal(c.acted, true)
  assert.equal(sent.length, 2)
  assert.equal(share.status().sent, 2)
})

test('相同画面去重：md5 一样就不重发，只累加 skipped', async () => {
  const same = join(DATA, 'shots', 'frame-same.jpg')
  writeFileSync(same, 'same-bytes')
  const ops = { run: async () => ({ ok: true, message: 'ok', data: { file: same, x: 0, y: 0, width: 1920, height: 1080 } }) }
  const { share, sent, t } = make({ ops })
  share.start({ chatId: 'private:10001' })
  await share.tick()
  assert.equal(sent.length, 1)
  t.v += 6_000
  const r = await share.tick()
  assert.equal(r.skipped, true)
  assert.equal(sent.length, 1)
  assert.equal(share.status().skipped, 1)
  // 超过 60 秒心跳窗口，即使画面没变也补一张
  t.v += 70_000
  const hb = await share.tick()
  assert.equal(hb.acted, true)
  assert.equal(sent.length, 2)
})

test('连续三次失败自动停：onEnd 收到原因，status 回到 inactive', async () => {
  let n = 0
  const ops = { run: async () => { n++; return { ok: false, message: '截屏炸了 ' + n } } }
  const { share, ends, t } = make({ ops })
  share.start({ chatId: 'private:10001' })
  await share.tick(); t.v += 5_000
  await share.tick(); t.v += 5_000
  await share.tick()
  const st = share.status()
  assert.equal(st.active, false)
  assert.match(st.lastError, /截屏炸了 3/)
  assert.equal(ends.length, 1)
  assert.match(ends[0].reason, /连续 3 次失败/)
})

test('到点自动停：时长为 N 分钟，越过 until 后 tick 返回 ended', async () => {
  const { share, t } = make({ patch: { shareMinutes: 1 } })
  share.start({ chatId: 'private:10001' })
  t.v += 61_000
  const r = await share.tick()
  assert.equal(r.active, false)
  assert.match(String(r.ended), /到点了/)
  assert.equal(share.status().active, false)
})

test('总开关关掉：下一次 tick 立即停（不做后台偷偷发画面的事）', async () => {
  const { share, live, t } = make()
  share.start({ chatId: 'private:10001' })
  live.enabled = false
  t.v += 5_000
  const r = await share.tick()
  assert.equal(r.active, false)
  assert.match(String(r.ended), /总开关/)
})

test('停止：从 active 回 inactive，再 tick 不动作', async () => {
  const { share } = make()
  share.start({ chatId: 'private:10001' })
  const r = share.stop('测试停止')
  assert.equal(r.ok, true)
  assert.match(r.message, /已停止/)
  assert.equal((await share.tick()).active, false)
})
