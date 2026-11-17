import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import mod from '../modules/roost-bridge/index.mjs'
import * as roost from '../modules/roost-bridge/lib/roost.mjs'
import * as state from '../modules/roost-bridge/lib/state.mjs'

const manifest = JSON.parse(readFileSync(new URL('../modules/roost-bridge/module.json', import.meta.url), 'utf8'))

test('模块清单与入口一致', () => {
  assert.equal(mod.id, manifest.id)
  assert.equal(mod.version, manifest.version)
  assert.equal(mod.api, manifest.api)
  assert.equal(mod.category, manifest.category)
  assert.deepEqual(manifest.capabilities, [
    'network',
    'filesystem',
    'process',
    'plugin-config',
    'dynamic-code',
    'plugin-internals',
  ])
})

test('panel.js 能被宿主 new Function 解析', () => {
  const source = readFileSync(new URL('../modules/roost-bridge/panel.js', import.meta.url), 'utf8')
  assert.doesNotThrow(() => new Function(source))
})

test('内置依赖放在 bundled/ 且能准备到 ROOST_HOME', () => {
  const vendorDir = fileURLToPath(new URL('../modules/roost-bridge/vendor/roost', import.meta.url))
  const home = mkdtempSync(join(tmpdir(), 'roost-bridge-deps-'))
  try {
    const result = roost.prepareDeps({ vendorDir, homeDir: home, log() {} })
    assert.equal(result.ok, true)
    const target = join(home, 'data', 'deps', 'ext', 'node_modules')
    for (const name of ['ws', 'silk-wasm']) {
      assert.ok(existsSync(join(target, name, 'package.json')), `缺 ${name}`)
    }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('接入时关空间能力，恢复时还原', () => {
  const patch = roost.aurabotPatch({ port: 6707, token: 't'.repeat(24), selfUin: '4015248048' })
  assert.equal(patch.gateway, 'onebot')
  assert.equal(patch.botQQ, '4015248048')
  assert.equal(patch.snowluma.wsUrl, 'ws://127.0.0.1:6707')
  assert.equal(patch.diary.enabled, false)
  assert.equal(patch.qzoneSocial.enabled, false)

  const restore = roost.restoreGatewayPatch({ botQQ: '2854204853', diary: true, qzoneSocial: true })
  assert.equal(restore.gateway, 'snowluma')
  assert.equal(restore.botQQ, '2854204853')
  assert.equal(restore.diary.enabled, true)
  assert.equal(restore.qzoneSocial.enabled, true)
})

test('落盘端口为 0 时仍能读出 token；lastBridgePort 可作为快照', () => {
  const home = mkdtempSync(join(tmpdir(), 'roost-bridge-port-'))
  try {
    mkdirSync(join(home, 'config', 'bots'), { recursive: true })
    writeFileSync(
      join(home, 'config', 'bots', 'main.json'),
      JSON.stringify({ onebot: { enabled: true, port: 0, token: 'stored-token', selfUin: '4015248048' } }),
    )
    const disk = roost.readBridgeSettings(home, 'main')
    assert.equal(disk.port, 0)
    assert.equal(disk.token, 'stored-token')

    state.set({ lastBridgePort: 6707 })
    assert.equal(state.get().lastBridgePort, 6707)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('启动时把 roost 自动更新锁成 false', () => {
  const home = mkdtempSync(join(tmpdir(), 'roost-bridge-autoapply-'))
  try {
    mkdirSync(join(home, 'config'), { recursive: true })
    const file = join(home, 'config', 'bot.json')
    writeFileSync(file, JSON.stringify({ update: { autoApply: true, autoCheck: true } }))
    const result = roost.lockAutoApply(home)
    assert.equal(result.ok, true)
    assert.equal(result.changed, true)
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(saved.update.autoApply, false)
    assert.equal(saved.update.autoCheck, true)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('随包 roost 有来源锁定与许可证例外', () => {
  const vendor = fileURLToPath(new URL('../modules/roost-bridge/vendor/roost/', import.meta.url))
  for (const name of ['LICENSE', 'LICENSE-EXCEPTION.md', 'SOURCE.md', 'SOURCE.sha256']) {
    assert.ok(existsSync(join(vendor, name)), `缺 ${name}`)
  }
  const lines = readFileSync(join(vendor, 'SOURCE.sha256'), 'utf8').trim().split('\n')
  assert.ok(lines.length >= 140, `校验和条目太少：${lines.length}`)
  assert.ok(lines.every((line) => /^[a-f0-9]{64}  \S+$/.test(line)))
})
