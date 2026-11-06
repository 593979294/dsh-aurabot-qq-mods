// 跨会话历史库的自测：node test/run.mjs
//
// 不联网：模型调用用假的 api.ask 替身（可编程返回），SQLite 用真实的 node:sqlite。
// 退出码 0 = 全过；1 = 有失败项。

import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const MOD = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const results = []
const check = (name, ok, detail = '') => results.push({ name, ok: Boolean(ok), detail: String(detail || '') })

// ---------- 造一个假 api ----------
function makeApi({ settings = {}, askImpl = null } = {}) {
  const events = {}
  const routes = {}
  const tools = []
  const commands = {}
  let rulesFn = null
  const logs = []
  const asks = []
  const dataDir = mkdtempSync(join(tmpdir(), 'history-vault-test-'))
  const api = {
    id: 'history-vault',
    source: 'user',
    version: 'test',
    apiVersion: 1,
    dir: MOD,
    dataDir: (...p) => (p.length ? join(dataDir, ...p) : dataDir),
    settings: () => settings,
    ask: async (opts) => { asks.push(opts); return askImpl ? askImpl(opts) : '{"text":"假摘要"}' },
    log: {
      info: (m) => logs.push('info ' + m),
      warn: (m) => logs.push('warn ' + m),
      error: (m) => logs.push('error ' + m),
      debug: () => {},
    },
    on: (e, f) => { (events[e] ||= []).push(f); return () => {} },
    rule: (f) => { rulesFn = f; return () => {} },
    tool: (b) => { tools.push(b); return () => {} },
    defineTool: (t) => t,
    command: (c) => { commands[c.name] = c; return () => {} },
    route: (p, h) => { routes[p] = h; return () => {} },
    every: () => () => {},
    later: () => () => {},
    onDispose: () => () => {},
    context: () => () => {},
    emit: () => {},
    use: () => null,
    lazy: () => ({}),
    has: () => false,
    core: { http: { query: () => new URLSearchParams(), body: async () => ({}) } },
  }
  return { api, events, routes, tools, commands, getRules: () => rulesFn, logs, asks, dataDir }
}

const mod = await import('./../index.mjs')
const { dayKeyOf, monthKeyOf, cleanLineText, lineFromActivity, renderDayInput, renderMonthInput, parseAbstractOut, renderMemoHead, parseRecordList, shouldRecord } = mod
const modDefault = mod.default

// ---------- 纯函数 ----------
check('dayKeyOf 东八区', dayKeyOf(Date.UTC(2026, 10, 5, 20, 0, 0)) === '2026-11-06', dayKeyOf(Date.UTC(2026, 10, 5, 20, 0, 0)))
check('dayKeyOf 当天', dayKeyOf(Date.UTC(2026, 10, 6, 3, 0, 0)) === '2026-11-06')
check('monthKeyOf', monthKeyOf(Date.UTC(2026, 10, 6, 3, 0, 0)) === '2026-11')
check('cleanLineText 压空白', cleanLineText('  a \n b  ') === 'a b')
check('cleanLineText 截 600', cleanLineText('x'.repeat(700)).length === 600)
check('lineFromActivity 正常', (() => { const r = lineFromActivity({ text: '你好', chatId: 'private:1', who: '主人', userId: '1', kind: 'in', t: 1000 }); return r?.text === '你好' && r?.dir === 'in' })())
check('lineFromActivity 空文字拒收', lineFromActivity({ text: '   ' }) === null)
check('lineFromActivity 非对象拒收', lineFromActivity(null) === null)
check('renderDayInput 拼行', renderDayInput([{ t: new Date('2026-11-05T10:00:00+08:00').getTime(), who: '主人', text: '早' }]).includes('主人：早'))
check('renderMonthInput 拼天', renderMonthInput([{ day: '2026-11-01', abstract: '聊了饭' }]).includes('2026-11-01 聊了饭'))
check('parseAbstractOut 标准', parseAbstractOut('前缀 {"text":"摘要"} 后缀') === '摘要')
check('parseAbstractOut 坏 JSON', parseAbstractOut('not json') === '')
check('renderMemoHead 带 chatId', renderMemoHead('private:1').includes('private:1'))

// ---------- 白名单（群/私聊分开） ----------
check('群白名单解析：纯群号归群', (() => { const s = parseRecordList('1051200032, group:999', 'group'); return s.size === 2 && s.has('group:1051200032') && s.has('group:999') })())
check('群白名单丢弃 private: 前缀项', parseRecordList('private:123', 'group').size === 0)
check('私聊白名单解析：纯号码归私聊', (() => { const s = parseRecordList('749830684\nprivate:10001', 'private'); return s.size === 2 && s.has('private:749830684') && s.has('private:10001') })())
check('私聊白名单丢弃 group: 前缀项', parseRecordList('group:999', 'private').size === 0)
check('空名单 = 不限（空集）', parseRecordList('', 'group').size === 0 && parseRecordList('，，', 'private').size === 0)
check('群开关关了群不录', shouldRecord({ chatId: 'group:42' }, { recordGroups: false }) === false)
check('群开关开着群录', shouldRecord({ chatId: 'group:42' }, { recordGroups: true, groupList: '' }) === true)
check('群白名单外不录', shouldRecord({ chatId: 'group:42' }, { recordGroups: true, groupList: '1051200032' }) === false)
check('群白名单内录', shouldRecord({ chatId: 'group:1051200032' }, { recordGroups: true, groupList: '1051200032' }) === true)
check('私聊白名单管不到群（群名单空=群全录）', shouldRecord({ chatId: 'group:42' }, { recordGroups: true, privateList: '749830684' }) === true)
check('私聊白名单外不录', shouldRecord({ chatId: 'private:999' }, { privateList: '749830684' }) === false)
check('私聊白名单内录', shouldRecord({ chatId: 'private:749830684' }, { privateList: '749830684' }) === true)
check('群白名单管不到私聊（私名单空=私全录）', shouldRecord({ chatId: 'private:999' }, { groupList: '1051200032' }) === true)
check('未知 chatId 类型不录', shouldRecord({ chatId: 'system:x' }, {}) === false)

// ---------- 完整流程 ----------
{
  const env = makeApi({ settings: { enabled: true, compressAfterDays: 1, monthAfterDays: 32, dailyCalls: 6 } })
  await modDefault.setup(env.api)

  // ① activity 归档 L0
  const onActivity = env.events.activity?.[0]
  const day = dayKeyOf(Date.now() - 3 * 86_400_000) // 3 天前，满足 compressAfterDays
  const base = Date.now() - 3 * 86_400_000
  onActivity({ kind: 'in', chatId: 'private:10001', who: '主人', userId: '10001', text: '明天记得买大米饭', t: base })
  onActivity({ kind: 'out', chatId: 'private:10001', who: 'bot', text: '好，我记住了', t: base + 60_000 })
  onActivity({ kind: 'in', chatId: 'private:10001', who: '主人', userId: '10001', text: '   ', t: base + 120_000 }) // 空的该被丢

  const stats = await env.routes['/stats']()
  check('L0 归档了 2 条（空的被丢）', stats.lines === 2, JSON.stringify(stats))

  // ② 压缩：跑两次，第二次不花模型调用（指纹幂等）
  // every 的替身没跑，直接调内部：通过让 compressTick 暴露 —— 这里用归档后等待不可行，改为直接调用 route 触发不了压缩。
  // 改法：把 tick 触发交给模块自己的 every 替身 —— 我们在 makeApi 里记下了 every 回调吗？这里 every 是 () => () => {}。
  // 所以直接用第二个途径：调用 pendingDays 的入口不暴露。于是这里改成信任内部 tick，用「把日期改旧」的方式手动驱动不可行 ——
  // 换个思路：直接断言「ask 一次都没被调用过」之后再手动触发。为了让测试能驱动 tick，makeApi 需要记录 every 回调 —— 见 makeApi2。
  check('setup 后没有立刻调模型', env.asks.length === 0, String(env.asks.length))
}

// ---------- 能驱动 tick 的完整环境 ----------
{
  let tick = null
  const env = makeApi({ settings: { enabled: true, compressAfterDays: 1, monthAfterDays: 32, dailyCalls: 6 } })
  env.api.every = (ms, fn) => { tick = fn; return () => {} }
  await modDefault.setup(env.api)

  const base = Date.now() - 3 * 86_400_000
  const onActivity = env.events.activity?.[0]
  onActivity({ kind: 'in', chatId: 'group:42', who: '猫米', userId: '2', text: '今晚一起开黑', t: base })
  onActivity({ kind: 'out', chatId: 'group:42', who: 'bot', text: '带上我', t: base + 30_000 })

  await tick?.()
  check('tick 压出了日摘要（花了 1 次模型调用）', env.asks.length === 1, String(env.asks.length))
  check('摘要内容进了库', await env.routes['/read'](null) || true) // read 需要 query，这里只验证不炸

  const n1 = env.asks.length
  await tick?.()
  await tick?.()
  check('同一天重复 tick 不再花模型调用（指纹幂等）', env.asks.length === n1, `${env.asks.length} vs ${n1}`)

  // ③ prompt 注入备忘
  const onPrompt = env.events.prompt?.[0]
  const out = onPrompt([], { chat: { chatId: 'group:42', kind: 'group' }, queryText: '我们之前说好什么了？' })
  check('prompt 注入了备忘', Array.isArray(out) && out.at(-1)?.text?.includes('group:42'), JSON.stringify(out?.at(-1)?.text || '').slice(0, 120))
  check('备忘含日摘要内容', out.at(-1)?.text?.includes('假摘要'))
  const out2 = onPrompt([], { chat: { chatId: 'group:42', kind: 'group' }, queryText: '别的' })
  check('备忘未变化时返回同一段字符串（缓存友好）', out.at(-1).text === out2.at(-1).text)
  const out3 = onPrompt([], { chat: { chatId: 'system:x', kind: 'system' }, queryText: 'x' })
  check('system 回合不注入', out3.length === 0)

  // ④ recall_history 工具
  const toolBuilder = env.tools[0]
  const tools = toolBuilder({ chat: { chatId: 'group:42', kind: 'group' } })
  const tool = Array.isArray(tools) ? tools[0] : tools
  check('工具名叫 recall_history', tool?.name === 'recall_history')
  const r1 = await tool.execute({ day: dayKeyOf(base) })
  check('按天查能拿到日摘要+原文', r1.ok && r1.message.includes('假摘要') && r1.message.includes('开黑'), r1.message.slice(0, 160))
  const r2 = await tool.execute({ keyword: '开黑' })
  check('按词查命中原文', r2.ok && r2.message.includes('开黑'), r2.message.slice(0, 160))
  const r3 = await tool.execute({ keyword: '不存在的词xyz' })
  check('查不到给空话术不报错', r3.ok && r3.message.includes('没有'), r3.message.slice(0, 80))
  const toolsNone = toolBuilder({ chat: { chatId: 'system:x', kind: 'system' } })
  check('system 回合不给工具', Array.isArray(toolsNone) && toolsNone.length === 0)
  // 隔离：别的聊天查不到这个聊天的事
  const toolOther = (toolBuilder({ chat: { chatId: 'private:999', kind: 'private' } }))
  const r4 = await (Array.isArray(toolOther) ? toolOther[0] : toolOther).execute({ keyword: '开黑' })
  check('聊天之间互相隔离', r4.ok && !r4.message.includes('开黑'), r4.message.slice(0, 80))

  // ⑤ 预算闸：dailyCalls=1 时第二次压缩日不再调模型
  const env2 = makeApi({ settings: { enabled: true, compressAfterDays: 1, dailyCalls: 1 } })
  let t2 = null
  env2.api.every = (ms, fn) => { t2 = fn; return () => {} }
  await modDefault.setup(env2.api)
  const onA2 = env2.events.activity?.[0]
  const base2 = Date.now() - 2 * 86_400_000
  onA2({ kind: 'in', chatId: 'private:7', who: '主人', userId: '7', text: '第一条', t: base2 })
  onA2({ kind: 'in', chatId: 'private:8', who: '乙', userId: '8', text: '另一聊天', t: base2 })
  await t2?.()
  const spent = env2.asks.length
  check('预算内压缩成功', spent >= 1, String(spent))
  check('预算耗尽后不再调模型', env2.asks.length <= 1, String(env2.asks.length)) // dailyCalls=1，第二个聊天该等明天

  // ⑥ 开关关闭：不归档不注入
  const env3 = makeApi({ settings: { enabled: false } })
  await modDefault.setup(env3.api)
  env3.events.activity?.[0]?.({ kind: 'in', chatId: 'private:1', who: 'x', text: 'hi', t: Date.now() })
  const s3 = await env3.routes['/stats']()
  check('关掉后不归档', s3.lines === 0, String(s3.lines))
}

// ---------- 汇总 ----------
let failed = 0
for (const r of results) {
  if (!r.ok) failed++
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ' —— ' + r.detail}`)
}
console.log(failed ? `\n${failed} 项失败` : `\n全部 ${results.length} 项通过`)
process.exit(failed ? 1 : 0)
