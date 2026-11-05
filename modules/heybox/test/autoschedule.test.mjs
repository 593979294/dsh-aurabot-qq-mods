import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHeybox } from '../lib/site.mjs'

// 固定东八区 + 固定「今天」，让 postsToday/排期时刻可复算。
process.env.TZ = 'Asia/Shanghai'

// 正文要过字数硬校验（fixture 里 postWordsMin=100）
const BODY = ('今天在小黑盒刷到一条很有意思的帖子，说的是某款游戏的新版本更新内容。'
  + '我仔细看了更新日志，发现这次改动涉及三个系统：背包整理、任务追踪和公会战匹配。'
  + '其中任务追踪终于支持跨地图自动寻路了，玩起来省事不少。').repeat(2)

const isPostPrompt = (p) => String(p).includes('写一篇小黑盒帖子')

/** 造一个能跑 tick 全链路（逛 + 自动发帖）的 fixture：网络全 mock、时间可控 */
function fx({ heybox = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'heybox-sched-'))
  mkdirSync(join(dir, 'packs'), { recursive: true })   // 空图库 → 纯文字帖放行
  const start = new Date(2026, 5, 8, 10, 0)            // 2026-06-08 10:00（周六）
  let time = start.getTime()
  const cfg = {
    enabled: true, dryRun: false, ownerQQ: '12345678', ownerName: '主人',
    speakUp: { awakeFrom: 0, awakeTo: 24 },
    heybox: {
      enabled: true, autoBrowse: true, cookie: 'pkey=abc; heybox_id=1',
      maxRunsPerDay: 1, intervalHours: 4, maxPostsPerDay: 2,
      dailyPosts: [{}, {}], postStyle: 'diary',
      postWordsMin: 100, postWordsMax: 3000, defaultTopic: 7214,
      ...heybox,
    },
  }
  const turns = []
  const posted = []
  const chat = {
    runSystemTurn: async (ext, title, prompt, opts) => {
      turns.push({ ext, title, prompt, opts })
      if (isPostPrompt(prompt)) {
        return JSON.stringify({ title: '排期到点自动发的测试帖', text: BODY })
      }
      return JSON.stringify({ note: '看到一个有趣的帖子', share: '', linkId: '', remember: '' })
    },
    sendText: async () => ({ message_id: 1 }),
  }
  const client = {
    dispose: () => {},
    riskInfo: () => ({ level: 0, until: 0, leftMs: 0 }),
    riskToken: () => 't',
    get: async (url) => {
      if (String(url).includes('/bbs/app/feeds')) {
        return {
          status: 'ok',
          result: { links: [{ linkid: '123456', title: '游戏新闻', user: { username: '盒友甲' }, link_like_count: 3, comment_num: 1, topics: [] }] },
        }
      }
      return { status: 'ok', result: {} }
    },
    post: async (path, body) => {
      if (String(path).includes('/link/post')) {
        posted.push(body)
        return { status: 'ok', result: { link_id: String(100000 + posted.length) } }
      }
      return { status: 'ok', result: {} }
    },
    putCOS: async () => true,
  }
  const stateFile = join(dir, 'state.json')
  writeFileSync(stateFile, JSON.stringify({
    quota: { date: '2026-06-08', post: 0, like: 0, comment: 0, browse: 0, share: 0 },
    acts: { date: '2026-06-08', fetchedAt: 1, list: [], plain: [] },
  }))
  const hb = createHeybox({
    getConfig: () => ({ ...cfg, heybox: { ...cfg.heybox } }),
    setCookie: () => {}, hub: chat, memory: {},
    log: { info: () => {}, warn: () => {} },
    stateFile, credFile: join(dir, 'x.json'), now: () => time,
    clientFactory: () => client,
    memeRoot: join(dir, 'packs'),
  })
  return {
    hb, cfg, turns, posted, stateFile, dir,
    get time() { return time },
    set time(v) { time = v },
    at(h, m = 0) { time = new Date(2026, 5, 8, h, m).getTime() },
    close() { hb.dispose(); rmSync(dir, { recursive: true, force: true }) },
  }
}

const postTurns = (f) => f.turns.filter((t) => isPostPrompt(t.prompt))

test('逛额度烧尽后到点仍能补发：每日排期不再只发出第 1 篇', async (t) => {
  const f = fx()
  t.after(() => f.close())

  // 第 1 轮：逛冷却过期（lastRun/browseAt 都是 0）→ runDuty 逛一圈 + 顺手发第 1 篇
  // 排期 slots=[0,12]：10:00 已过第 1 篇的点（rel=2 ≥ 0）
  const r1 = await f.hb.tick()
  assert.equal(r1.due, true)
  assert.equal(postTurns(f).length, 1, '第一轮该发出第 1 篇')
  assert.equal(f.hb.state().quota.browse, 1, '逛额度用掉 1')
  assert.equal(f.hb.state().quota.post, 1)

  // 第 2 篇的计划点在 12:00（唤醒窗口 0-24 均分 2 份）；11:00 还没到 → 不发
  f.at(11, 0)
  const r2 = await f.hb.tick()
  assert.equal(r2.due, false, '第 2 篇没到点不发')
  assert.equal(postTurns(f).length, 1)

  // 13:00：已过第 2 篇的点；逛额度烧尽（maxRunsPerDay=1）且逛冷却也没过。
  // 旧版这条路会先在 left('browse') 或 lastRun 冷却上早退，永远发不出第 2 篇。
  f.at(13, 0)
  const r3 = await f.hb.tick()
  assert.equal(r3.due, true, '到点就该补发，不受逛额度/冷却牵连')
  assert.equal(postTurns(f).length, 2, '第 2 篇到点自动发出')
  assert.equal(f.hb.state().quota.post, 2, '当日排期 2 篇发满')
  assert.equal(f.hb.state().quota.browse, 1, '补发这一轮不该再消耗逛额度')
  assert.equal(f.posted.length, 2, '真的 POST 了两次 /link/post')
  const hist = f.hb.state().history.filter((h) => h.kind === 'post')
  assert.equal(hist.length, 2, 'history 里要有两条 post 记录（postsToday 的依据）')

  // 4) 排期发满后不再触发
  f.at(13, 1)
  const r4 = await f.hb.tick()
  assert.equal(r4.due, false, '发满了就不该再 due')
  assert.equal(postTurns(f).length, 2)
})

test('postWindowOpen：到点才 due，发满/关掉自动发帖都不 due', async (t) => {
  const f = fx()
  t.after(() => f.close())
  const cfg = f.cfg
  const hh = (h, m = 0) => new Date(2026, 5, 8, h, m)

  // 还没发：第 1 篇的点是 0（一醒来就到点）→ 10:00 已过点 → due
  assert.equal(f.hb.postWindowOpen(cfg, hh(10)), true)
  // 手动造「已发 1 篇」→ 下一篇的点是 12:00：11:00 不到点 / 13:00 到点
  const { writeFileSync: w } = await import('node:fs')
  const st = JSON.parse((await import('node:fs')).readFileSync(f.stateFile, 'utf8'))
  st.history = [{ at: hh(10).getTime(), kind: 'post', linkId: '1' }, ...(st.history || [])]
  w(f.stateFile, JSON.stringify(st))
  assert.equal(f.hb.postWindowOpen(cfg, hh(11)), false, '11:00 第 2 篇还没到点')
  assert.equal(f.hb.postWindowOpen(cfg, hh(13)), true, '13:00 第 2 篇到点了')

  // 两篇都发完 → 不再 due
  st.history = [{ at: hh(10).getTime(), kind: 'post', linkId: '1' }, { at: hh(13).getTime(), kind: 'post', linkId: '2' }]
  w(f.stateFile, JSON.stringify(st))
  assert.equal(f.hb.postWindowOpen(cfg, hh(20)), false, '发满了不 due')

  // 面板关掉自动发帖 → 不 due（安全阀）
  const st2 = JSON.parse((await import('node:fs')).readFileSync(f.stateFile, 'utf8'))
  st2.history = []
  w(f.stateFile, JSON.stringify(st2))
  cfg.heybox.autoPost = false
  assert.equal(f.hb.postWindowOpen(cfg, hh(20)), false, 'autoPost=false 不 due')
  const r = await f.hb.maybeAutoPost({})
  assert.equal(r.skipped, true)
  assert.match(r.message, /自动发帖已关/)
})

test('没配排期就绝不自动发（maybeAutoPost 空排期安全阀）', async (t) => {
  const f = fx({ heybox: { dailyPosts: [] } })
  t.after(() => f.close())
  const r = await f.hb.maybeAutoPost({})
  assert.equal(r.skipped, true)
  assert.match(r.message, /没配排期/)
  assert.equal(f.posted.length, 0)
  assert.equal(f.hb.postWindowOpen(f.cfg, new Date(2026, 5, 8, 20)), false)
})
