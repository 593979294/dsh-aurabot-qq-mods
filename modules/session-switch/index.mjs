// 会话切换：让她把一件事带到另一个聊天去。
//
// 每个 QQ 聊天（private:QQ号 / group:群号）在插件里是一个独立会话，各有各的上下文和记忆。
// 这个模块给她一个工具，把「一件事」交给另一个会话：那边的她带着自己的记忆去理解、接着说，
// 而不是把原话复制粘贴过去。原话直发是 direct 模式（不惊动那边的会话）。
//
// 认不出「王总」是谁的时候，她可以列出现在能带话到的聊天（带一点整理过的印象）问清楚；
// 确认过的称呼记下来，下次直接认；那个聊天发不过去了，就把记着的称呼删掉。
//
// 只改这个文件夹，不碰插件本身。

import {
  MARK,
  CONTENT_LIMIT,
  aliasAdd,
  aliasDrop,
  aliasFind,
  aliasesOf,
  allowedChat,
  allowOf,
  appendLog,
  briefing,
  catalog,
  chatOfId,
  fmtEntry,
  fmtRow,
  inRange,
  impressionOf,
  labelOf,
  loadAliases,
  nameIn,
  readLog,
  resolveRange,
  resolveTarget,
  saveAliases,
} from './lib/relay.mjs'

const CLAMP = (v, fallback, min, max) => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.floor(n))) : fallback
}

export default {
  id: 'session-switch',
  name: '会话切换',
  version: '1.2.0',
  api: 1,
  description: '让她把一件事带到另一个聊天：那边的她按自己的记忆和方式接住，不是把原话复制过去。认不出是谁时可以列出会话问清楚，确认过的称呼会记住。',
  category: 'social',
  tags: ['跨会话', '转达', '穿透', '会话清单'],
  minPluginVersion: '1.2.0',
  requires: [],
  capabilities: ['filesystem', 'plugin-config', 'plugin-internals'],
  defaults: {
    enabled: true,
    allowOwner: true,
    allowOthers: true,
    ownerTargets: '',
    othersTargets: '',
    mode: 'compose',
    rememberNames: true,
    cooldownSec: 30,
    maxPerHour: 20,
  },
  settings: [
    { key: 'enabled', label: '启用会话切换', type: 'switch', hint: '关掉后她没有这个工具，也不会有这条规则' },
    {
      key: 'allowOwner',
      label: '允许主人带话',
      type: 'switch',
      hint: '关掉后主人（含主人开口的那一轮）也不能把话带到别的聊天',
    },
    {
      key: 'allowOthers',
      label: '允许别人带话',
      type: 'switch',
      hint: '关掉后群里、别人私聊里的人说的话，她不会帮着往别处带（列清单、临时起意也一起停掉）',
    },
    {
      key: 'ownerTargets',
      label: '主人可带话的范围',
      type: 'textarea',
      placeholder: '123456, 908975701, 1773199891',
      hint: '填 QQ 号或群号，逗号或换行分隔，群聊私聊自动区分（群号进群、QQ 号进私聊）；留空 = 所有会话。范围再宽也不会超出面板「聊天」页的白名单',
    },
    {
      key: 'othersTargets',
      label: '别人可带话的范围',
      type: 'textarea',
      placeholder: '3153882572',
      hint: '群友、陌生人能让她往哪些聊天带（填法同上）；留空 = 所有会话。一般填主人私聊或几个群就行',
    },
    {
      key: 'mode',
      label: '默认方式',
      type: 'select',
      options: [
        { value: 'compose', label: '交给那边的她接着说（默认）' },
        { value: 'direct', label: '原话直接发过去，不惊动那边的会话' },
      ],
    },
    {
      key: 'rememberNames',
      label: '记住「王总」这种称呼和聊天的对应',
      type: 'switch',
      hint: '只在主人确认过的场合记；记过的聊天发不过去时会自动删掉',
    },
    { key: 'cooldownSec', label: '同一个聊天多久内只带一次（秒）', type: 'number', min: 0, max: 600, step: 5 },
    { key: 'maxPerHour', label: '每小时最多带几次', type: 'number', min: 1, max: 200, step: 1 },
  ],

  setup(api) {
    const { hub } = api.core
    const dir = api.dataDir()
    const log = api.log

    const on = () => api.settings().enabled !== false
    const settings = () => api.settings()
    const num = (v, fallback, min, max) => CLAMP(v, fallback, min, max)

    const lastTo = new Map() // 目标 chatId → 上次带过去的时刻
    const sentAt = [] // 最近带过去的时间戳，做每小时频控

    const ownerOf = () => String(api.config().ownerQQ || '')
    const isOwnerPrivate = (chat) => chat?.kind === 'private' && String(chat.userId || '') === ownerOf()
    const ownerTurn = (sessionId) => {
      try {
        return Boolean(sessionId && typeof hub.turnSendersAllOwner === 'function' && hub.turnSendersAllOwner(sessionId))
      } catch (error) {
        return false
      }
    }

    /** 这一轮算不算「主人在说话」：主人私聊，或者群里这一轮只有主人开口。 */
    const speakingAsOwner = (chat, sessionId) => isOwnerPrivate(chat) || ownerTurn(sessionId)

    /**
     * 这一轮能带到哪些聊天：返回 { ids, unknown }。
     * ids 为空 Set 表示不限制（所有能带话的会话）；unknown 是设置里填了但认不出的号。
     */
    const rangeCache = new Map()
    async function rangeOf(isOwner) {
      const s = settings()
      const text = String((isOwner ? s.ownerTargets : s.othersTargets) || '')
      const hit = rangeCache.get(text)
      if (hit && Date.now() - hit.at < 60_000) return hit.value
      const value = await resolveRange(api, text)
      rangeCache.set(text, { at: Date.now(), value })
      return value
    }

    /** 这一轮能不能往别处带（两个开关）。 */
    function canInitiate(isOwner) {
      return settings()[isOwner ? 'allowOwner' : 'allowOthers'] !== false
    }

    /** 参数没给就跟随设置里的默认方式。 */
    function modeOf(wanted) {
      const m = String(wanted || '').trim().toLowerCase()
      if (m === 'direct' || m === 'compose') return m
      return settings().mode === 'direct' ? 'direct' : 'compose'
    }

    function tooSoon(targetId) {
      const s = settings()
      const now = Date.now()
      const cool = num(s.cooldownSec, 30, 0, 600) * 1000
      const last = lastTo.get(targetId) || 0
      if (cool > 0 && now - last < cool) return Math.ceil((cool - (now - last)) / 1000)
      return 0
    }

    function overCap() {
      const cap = num(settings().maxPerHour, 20, 1, 200)
      const now = Date.now()
      while (sentAt.length && now - sentAt[0] > 3600_000) sentAt.shift()
      return sentAt.length >= cap
    }

    function mark(targetId) {
      const now = Date.now()
      lastTo.set(targetId, now)
      sentAt.push(now)
    }

    /** 记下用户说的称呼；只在主人（或本轮全是主人）的场合记，免得群里的人乱改对应。scope 是哪边在这么叫。 */
    function remember(name, chatId, allowedToRemember, scope = '') {
      const want = String(name || '').trim()
      if (!want || !allowedToRemember || settings().rememberNames === false) return ''
      const sid = String(hub.sessions?.()?.[chatId]?.sessionId || '')
      const next = aliasAdd(loadAliases(dir), { name: want, chatId, sessionId: sid, scope })
      saveAliases(dir, next)
      return `，记住了「${want}」就是这里`
    }

    /** 发不过去：把这个聊天的记忆删掉（给了名字就只删这条）。 */
    function forget(chatId, name) {
      const list = loadAliases(dir)
      const keep = aliasDrop(list, chatId, name)
      if (keep.length === list.length) return ''
      saveAliases(dir, keep)
      return '（记着的称呼也一起删了）'
    }

    /**
     * 真正的转达。sourceChat 是发起这边的聊天（用来判断权限和记来源）。
     * 返回 { ok, message }；compose 模式不等那边的她说完，先把「带到了」交回去。
     */
    async function tell({ sourceChat, sourceLabel, targetInput, content, mode, via, dryRun, name, canRemember, isOwner }) {
      if (!on()) return { ok: false, message: '会话切换关着' }

      const text = String(content || '').trim()
      if (!text) return { ok: false, message: '没说要带走什么' }
      if (text.length > CONTENT_LIMIT) return { ok: false, message: `太长了，压到 ${CONTENT_LIMIT} 字以内，带过去的是「一件事」不是整段聊天` }

      const fromOwner = Boolean(isOwner)
      if (!canInitiate(fromOwner)) {
        return { ok: false, message: fromOwner ? '设置里关掉了「允许主人带话」' : '设置里关掉了「允许别人带话」' }
      }

      const aliases = loadAliases(dir)
      const scope = String(sourceChat.chatId)
      const hit = await resolveTarget(api, targetInput, aliases, scope)
      if (hit.error) return { ok: false, message: hit.error }
      const target = hit.chat
      if (String(target.chatId) === String(sourceChat.chatId)) {
        return { ok: false, message: '这就是当前聊天，直接在这儿说就行' }
      }
      const range = await rangeOf(fromOwner)
      if (!inRange(range.ids, target.chatId)) {
        const where = [...range.ids].map((x) => chatOfId(x)).filter(Boolean)
        const names = where.length ? `…能带到的是：${where.map((c) => (c.kind === 'group' ? `群${c.groupId}` : `QQ${c.userId}`)).join('、')}` : ''
        return { ok: false, message: `${fromOwner ? '主人' : '别人'}可带话的范围里没有这个聊天${names}` }
      }

      const toldAs = hit.via === 'alias' ? String(hit.alias || '') : ''
      const targetLabel = await labelOf(api, target)
      const fromLabel = sourceLabel || (await labelOf(api, sourceChat))
      // 「来自 X」用听的那个人这边怎么称呼来源；没记过就用 QQ 昵称，不用「主人」这种她那边听不懂的叫法
      const srcName = await nameIn(api, sourceChat, aliases, target.chatId)
      const payload = briefing(srcName, text)
      const maybeRemember = name || (hit.via === 'name' ? String(targetInput).trim() : '')

      // 模拟测试：校验照做，但不真发、不占额度、不记账
      if (dryRun) {
        const what = mode === 'direct' ? `原话发到${targetLabel}` : `带到${targetLabel}，交给那边的内容：\n${payload}`
        return { ok: true, message: `（模拟测试，没有真的发）会${what}` }
      }

      const wait = tooSoon(target.chatId)
      if (wait) return { ok: false, message: `刚给那边带过话，${wait} 秒后再说` }
      if (overCap()) return { ok: false, message: `这个小时带过去 ${sentAt.length} 次了，先歇会儿` }

      const entry = {
        at: Date.now(),
        from: sourceChat.chatId,
        fromLabel,
        to: target.chatId,
        toLabel: targetLabel,
        mode,
        via: via || 'tool',
        text,
        ok: false,
      }
      mark(target.chatId)

      // 原话直发：不惊动那边的会话，own:false 让那边的她下次知道「这话是你在这边说的」
      if (mode === 'direct') {
        try {
          const r = await hub.deliver(target.chatId, text, { own: false })
          if (!r || r.failed) {
            entry.error = r?.failed ? String(r.errors?.[0] || '发送失败') : '没发出去（可能被模块拦下或内容为空）'
            const gone = forget(target.chatId, toldAs)
            appendLog(dir, entry)
            return { ok: false, message: `没发到${targetLabel}：${entry.error}${gone}` }
          }
          entry.ok = true
          appendLog(dir, entry)
          return { ok: true, message: `原话发到${targetLabel}了${remember(maybeRemember, target.chatId, canRemember, scope)}` }
        } catch (error) {
          entry.error = String(error?.message || error)
          const gone = forget(target.chatId, toldAs)
          appendLog(dir, entry)
          return { ok: false, message: `没发到${targetLabel}：${entry.error}${gone}` }
        }
      }

      // compose：往那边会话注入一份简报并起一轮，由那边的她接着说。
      // 不 await（那边可能要说一阵子），但推送失败要记下来并把失效的称呼删掉。
      Promise.resolve()
        .then(() => hub.pushToSession(target, [{ type: 'text', text: payload }], '', { queryText: payload }))
        .then(() => {
          entry.ok = true
          appendLog(dir, entry)
          if (settings().rememberNames !== false && canRemember) {
            const sid = String(hub.sessions?.()?.[target.chatId]?.sessionId || '')
            if (sid && maybeRemember) {
              const next = aliasAdd(loadAliases(dir), { name: maybeRemember, chatId: target.chatId, sessionId: sid, scope })
              saveAliases(dir, next)
            }
          }
          log.info(`会话切换：${entry.from} → ${entry.to}`)
        })
        .catch((error) => {
          entry.error = String(error?.message || error)
          forget(target.chatId, toldAs)
          appendLog(dir, entry)
          log.warn(`会话切换失败（${entry.from} → ${entry.to}）：`, entry.error)
        })

      return { ok: true, message: `带到${targetLabel}了，那边的她会自己接着${remember(maybeRemember, target.chatId, canRemember, scope)}` }
    }

    /** 这一轮是不是「从别处带过来的」——是的话别再往外带，免得 A→B→C 接力。 */
    function carriedHere(sessionId) {
      try {
        return String(hub.lastTextOf?.(sessionId) || '').startsWith(MARK)
      } catch (error) {
        return false
      }
    }

    /** 这个聊天里能带话到的清单：只列这一轮允许的范围（范围留空 = 全部能带话的会话）。 */
    async function reachableRows(chat, sessionId) {
      const isOwner = speakingAsOwner(chat, sessionId)
      const aliases = loadAliases(dir)
      const all = await catalog(api, aliases, chat.chatId)
      const range = await rangeOf(isOwner)
      return { isOwner, rows: all.filter((r) => inRange(range.ids, r.chatId)) }
    }

    // ---------- 她的工具 ----------

    api.tool(({ chat, sessionId }) => {
      if (chat.kind === 'system') return []
      if (!on()) return []
      const isOwner = speakingAsOwner(chat, sessionId)
      if (!canInitiate(isOwner)) return []
      const canRemember = isOwner

      const tools = [
        api.defineTool({
          name: 'session_switch_tell',
          description: '把一件事带到另一个聊天去：那边的你带着自己的记忆去理解、接着说。target 填 private:QQ号、group:群号、群名、这个聊天里记过的称呼（如「王总」），或 owner（主人的私聊）；只能发白名单里的人和群。认不出是谁就先别猜，用 session_switch_list 列出来问清楚。带不带、带什么、怎么带，自己判断，不用有求必应。',
          properties: {
            target: { type: 'string', description: '带到哪儿：private:QQ号、group:群号、群名、称呼，或 owner' },
            content: { type: 'string', description: `要带过去的那件事，说清楚是什么（不是逐字稿，最多 ${CONTENT_LIMIT} 字）` },
            mode: { type: 'string', description: 'compose：让那边的她接着说（默认）；direct：原样发过去，不惊动那边的会话' },
            name: { type: 'string', description: '用户用来指代这个目标的称呼（如「王总」）；用户确认过就填，之后会记住' },
          },
          required: ['target', 'content'],
          execute: async ({ target, content, mode, name }) => {
            if (!on()) return { ok: false, message: '会话切换关着' }
            // 模拟测试里 sessionId 固定是 'sim'：校验照做，但不真发
            const dryRun = sessionId === 'sim'
            if (!dryRun && carriedHere(sessionId)) {
              return { ok: false, message: '这一轮本身就是从别处带过来的，先在这个聊天里处理；别往外再带。' }
            }
            return await tell({
              sourceChat: chat,
              sourceLabel: await labelOf(api, chat),
              targetInput: target,
              content,
              mode: modeOf(mode),
              dryRun,
              name,
              canRemember,
              isOwner,
            })
          },
        }),
      ]

      // 清单谁都能看，但只看得到自己这一轮能带话到的范围
      {
        tools.push(
          api.defineTool({
            name: 'session_switch_list',
            description: '不确定该把话带给谁时用：列出你能带话到的聊天（可以带一点你对那边的印象），然后问清楚是哪一个再带。自己临时想找谁说话时，也用它按印象挑一个，不用问对方。清单是印象不是聊天记录，别当成聊天内容念出来。',
            properties: {
              query: { type: 'string', description: '人名、称呼、群名或印象里的关键词；空着就列全部' },
              with_impression: { type: 'boolean', description: '要不要带一点对那边的印象（默认要）' },
            },
            execute: async ({ query, with_impression }) => {
              const { rows: all } = await reachableRows(chat, sessionId)
              let rows = all
              const key = String(query || '').trim().toLowerCase()
              if (key) {
                rows = rows.filter((r) => {
                  const hay = [r.label, r.chatId, r.impression, ...(r.names || [])].join(' ').toLowerCase()
                  return hay.includes(key)
                })
              }
              if (!rows.length) {
                return {
                  ok: true,
                  message: key ? `没找到和「${query}」对得上的聊天。可以不带关键词再列一次。` : '现在没有能带话到的聊天',
                }
              }
              const showImpression = with_impression !== false
              const withId = isOwnerPrivate(chat)
              const lines = rows.slice(0, 20).map((r, i) => fmtRow(i + 1, r, { withImpression: showImpression, withId }))
              const tail = rows.length > 20 ? `\n……还有 ${rows.length - 20} 个没列` : ''
              return {
                ok: true,
                message: `能带话到的地方（${rows.length}）：\n${lines.join('\n')}${tail}\n\n对不上人就直接问清楚；确认之后可以用 session_switch_remember 记住称呼。`,
              }
            },
          }),
        )
      }

      if (canRemember) {
        tools.push(
          api.defineTool({
            name: 'session_switch_remember',
            description: '用户确认了「以后我这里说的「王总」就是那个聊天」之后，把这个称呼记在当前这个聊天里，下次在这个聊天里说「王总」就能直接认。别处怎么说另算。只记用户确认过的，不要自己猜着记。',
            properties: {
              name: { type: 'string', description: '用户用的称呼，比如「王总」「chaos」' },
              target: { type: 'string', description: 'private:QQ号、group:群号、群名或 owner' },
            },
            required: ['name', 'target'],
            execute: async ({ name, target }) => {
              const want = String(name || '').trim()
              if (!want) return { ok: false, message: '没说是什么称呼' }
              const aliases = loadAliases(dir)
              const hit = await resolveTarget(api, target, aliases)
              if (hit.error) return { ok: false, message: hit.error }
              const sid = String(hub.sessions?.()?.[hit.chat.chatId]?.sessionId || '')
              const next = aliasAdd(aliases, { name: want, chatId: hit.chat.chatId, sessionId: sid, scope: chat.chatId })
              saveAliases(dir, next)
              return { ok: true, message: `记住了：「${want}」→ ${await labelOf(api, hit.chat)}` }
            },
          }),
        )
      }

      return tools
    })

    // ---------- 告诉她有这本事（只说能力，不示范措辞） ----------

    api.rule((kind) => {
      if (!on()) return ''
      const s = settings()
      const isPrivate = kind === 'private'
      // 这条规则不分主客：两个开关都关着时干脆不提。
      if (s.allowOwner === false && s.allowOthers === false) return ''
      const listHint = '，不确定在说谁时可以列一列能带话到的地方（session_switch_list），只能看到你被允许带的那些'
      const incoming = `有人往你这里带了以「${MARK}…】」开头的消息时，那是别的聊天托来的话，不是这个聊天里的人说的：要接就接着这里的话头说，别没头没尾地单甩一句。`
      const own = '你自己临时想找谁说话、或者忽然想把一件事告诉某个人时，不用问对方该找谁，也不用等谁确认：照你对那些聊天的印象挑一个最合适的，直接就带过去。'
      if (isPrivate) {
        return `你能把一件事带到别的聊天去（session_switch_tell）：那边会话里的你会按自己记着的事去理解，接着怎么说是她那边的事${listHint}。带不带、带什么、要不要有求必应，你自己判断；别人托付的私事、不该外传的，别带出去。${own}${incoming}`
      }
      return `在这个聊天里，你也可以把一件事带到别处去（session_switch_tell）。不过这里说的话很多人看得见，带谁的话、带去哪个聊天、带不带，自己掂量。${own}${incoming}`
    })

    // ---------- 主人命令 ----------

    // 先注册记录 / 列表 / 别名：命令是逐个按放宽规则匹配的，/转达记录 会被后注册的 /转达 当成长度前缀吃掉。
    // 名字避开小本本的 /记（它会把 /记录 当 /记+录）。
    api.command({
      name: '跨会话记录',
      aliases: ['转达记录'],
      desc: '看最近的跨会话转达记录：/跨会话记录 10（也可以 /转达记录）',
      run: async (arg) => {
        const n = num(arg, 10, 1, 50)
        const rows = readLog(dir, n)
        if (!rows.length) return '还没有转达记录。'
        return rows.reverse().map(fmtEntry).join('\n')
      },
    })

    api.command({
      name: '跨会话列表',
      aliases: ['会话列表', '转达列表'],
      desc: '列出能带话到的聊天和她的印象：/跨会话列表；按关键词找：/跨会话列表 王总',
      run: async (arg, msg) => {
        let rows = await catalog(api, loadAliases(dir), msg?.chatId || '')
        // 主人命令也按主人范围收窄，免得列出来的东西她其实带不过去
        const range = await rangeOf(true)
        rows = rows.filter((r) => inRange(range.ids, r.chatId))
        const key = String(arg || '').trim().toLowerCase()
        if (key) {
          rows = rows.filter((r) => [r.label, r.chatId, r.impression, ...(r.names || [])].join(' ').toLowerCase().includes(key))
        }
        if (!rows.length) return key ? `没找到和「${arg}」对得上的聊天。` : '现在没有能带话到的聊天。'
        return rows.map((r, i) => fmtRow(i + 1, r, { withId: true })).join('\n')
      },
    })

    api.command({
      name: '跨会话别名',
      aliases: ['跨会话记忆', '转达别名'],
      desc: '看她在这个聊天里记住了哪些称呼：/跨会话别名；删掉一条：/跨会话别名 删 王总；看全部：/跨会话别名 全部',
      run: async (arg, msg) => {
        const raw = String(arg || '').trim()
        const scope = String(msg?.chatId || '')
        const list = loadAliases(dir)
        const m = /^(删|忘记|delete|del)\s+(\S+.*)$/i.exec(raw)
        if (m) {
          const want = m[2].trim()
          const hit = aliasFind(list, want, scope)
          if (!hit) return `这个聊天里没记过「${want}」`
          saveAliases(dir, aliasDrop(list, hit.chatId, want, scope))
          return `删掉了：「${hit.name}」`
        }
        const showAll = /^(全部|all)$/i.test(raw)
        const rows = []
        const seen = new Set()
        for (let i = list.length - 1; i >= 0 && rows.length < 40; i--) {
          const x = list[i]
          if (!showAll && String(x.scope || '') !== scope) continue
          const k = `${x.scope}→${x.name}→${x.chatId}`
          if (seen.has(k)) continue
          seen.add(k)
          const label = await labelOf(api, chatOfId(x.chatId) || {})
          const d = new Date(x.at || 0)
          const where = showAll ? `〔${x.scope ? await labelOf(api, chatOfId(x.scope) || {}) : '旧记录，未分语境'}〕` : ''
          rows.push(`「${x.name}」→ ${where}${label}（${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} 记的）`)
        }
        if (!rows.length) {
          const elsewhere = list.length
          return elsewhere
            ? `这个聊天里还没记过称呼（别处记的 ${elsewhere} 条在这里不算）。看看整体：/跨会话别名 全部`
            : '还没记住任何称呼。'
        }
        return `${showAll ? '所有称呼（按语境，新的在前）' : '这个聊天里记的称呼（新的在前）'}：\n${rows.join('\n')}`
      },
    })

    api.command({
      name: '转达',
      desc: '把一件事带到别的聊天：/转达 王总 明天我不去了（目标也可以写 group:群号、群名、private:QQ号 或 owner）',
      run: async (arg, msg) => {
        // 中文命令后面不加空格时，插件会把「/转达群:123」拆成「群」+「:123」，这里拼回去
        const raw = String(arg || '')
          .trim()
          .replace(/^(群聊|群|私聊|private|group|qq)\s+(?=[:：\d])/i, '$1')
        const m = /^(\S+)\s+([\s\S]+)$/.exec(raw)
        if (!m) return '用法：/转达 目标 内容。目标是 group:群号、群名、称呼、private:QQ号 或 owner'

        const targetInput = m[1]
        const content = m[2].trim()
        const sourceChat = { chatId: msg.chatId, kind: msg.kind, userId: msg.userId, groupId: msg.groupId }

        const r = await tell({
          sourceChat,
          sourceLabel: await labelOf(api, sourceChat),
          targetInput,
          content,
          mode: modeOf(),
          via: 'command',
          // /modules/simulate 里 msg.messageId 是 'sim'
          dryRun: msg.messageId === 'sim',
          name: /^[\u4e00-\u9fa5A-Za-z]{1,12}$/.test(targetInput) && !/^(owner|master|主人)$/i.test(targetInput) ? targetInput : '',
          canRemember: true,
          isOwner: true,
        })
        return r.message
      },
    })

    return {}
  },
}
