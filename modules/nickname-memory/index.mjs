// 昵称记忆：记住别人怎么称呼一个人，也允许她自己给没称呼的人起个叫法
import {
  MAX_NAME_LEN, MAX_NAMES, isQQ, normalizeName, loadStore, saveStore, learnName, forgetName, forgetPerson,
  findByQQ, findByName, listPeople, namesOfChat, otherNames,
} from './lib/store.mjs'

const short = (text, n = 60) => {
  const s = String(text || '').replace(/\s+/g, ' ').trim()
  return s.length > n ? s.slice(0, n) + '…' : s
}

const labelOf = (person) => `${person.current || person.names[person.names.length - 1].name}（${person.qq}）`

const describe = (person, withQQ = true) => {
  const head = withQQ ? labelOf(person) : person.current
  const others = otherNames(person)
  return others.length ? `${head} · 也叫过：${others.join('、')}` : head
}

export default {
  id: 'nickname-memory',
  name: '昵称记忆',
  version: '1.1.0',
  api: 1,
  panel: 'panel.js',
  description: '她会记住大家怎么称呼一个人（也能自己给对方起个叫法），以后就用这个称呼叫对方；新叫法会顶掉旧的。',
  category: 'social',
  tags: ['昵称', '称呼', '认人', '记忆'],
  defaults: {
    enabled: true,
    allowSelfName: true,
    injectContext: true,
    maxNamesPerPerson: 6,
  },
  settings: [
    { key: 'enabled', label: '启用昵称记忆', type: 'switch' },
    { key: 'allowSelfName', label: '允许她自己起称呼', type: 'switch', hint: '关掉以后，她只能记别人用过的叫法' },
    { key: 'injectContext', label: '把称呼带进对话', type: 'switch', hint: '说话的人有记过的称呼时，提示她用这个称呼' },
    {
      key: 'maxNamesPerPerson',
      label: '每人最多记几个叫法',
      type: 'number',
      min: 1,
      max: MAX_NAMES,
      step: 1,
      hint: '超出的先忘最早那个；现在用的那个不算在内',
    },
  ],

  setup(api) {
    const dir = api.dataDir()
    const settings = () => api.settings() || {}
    const enabled = () => settings().enabled !== false

    let cache = null
    const store = () => {
      if (!cache) cache = loadStore(dir)
      return cache
    }
    const save = () => saveStore(dir, store())

    const members = new Map() // groupId -> { at, rows }
    async function groupMembers(groupId) {
      const gid = String(groupId || '')
      if (!gid) return []
      const hit = members.get(gid)
      if (hit && Date.now() - hit.at < 5 * 60_000) return hit.rows
      try {
        const list = await api.onebot('get_group_member_list', { group_id: Number(gid) }, { timeoutMs: 15000 })
        const rows = (Array.isArray(list) ? list : []).map((m) => ({
          qq: String(m?.user_id || ''),
          card: normalizeName(m?.card || ''),
          name: normalizeName(m?.nickname || ''),
        })).filter((m) => isQQ(m.qq))
        members.set(gid, { at: Date.now(), rows })
        return rows
      } catch (error) {
        api.log.warn('取群成员失败：', error.message)
        members.set(gid, { at: Date.now(), rows: [] })
        return []
      }
    }

    /** person 可以是 QQ 号、记过的叫法，或者群里的名片 / 昵称 */
    async function resolvePerson(chat, input) {
      const raw = String(input || '').trim()
      if (!raw) return { error: '没说清楚是谁' }
      if (isQQ(raw)) return { qq: raw }

      const hits = findByName(store(), raw)
      const exact = hits.filter((h) => h.exact)
      if (exact.length === 1) return { qq: exact[0].person.qq, via: 'name', matched: exact[0].matched }
      if (exact.length > 1) {
        return {
          error: `「${raw}」在你这儿对应好几个人：${exact.map((h) => describe(h.person)).join('；')}。给 QQ 号更准。`,
        }
      }
      if (hits.length === 1) return { qq: hits[0].person.qq, via: 'name', matched: hits[0].matched }

      if (chat.kind === 'group') {
        const rows = await groupMembers(chat.groupId)
        const same = (row) => row.card === raw || row.name === raw
        let found = rows.filter(same)
        if (found.length > 1) {
          return { error: `群里叫「${raw}」的有好几个人：${found.map((m) => `${m.card || m.name}（${m.qq}）`).join('、')}。给 QQ 号更准。` }
        }
        if (!found.length) {
          const loose = rows.filter((m) => (m.card && m.card.includes(raw)) || (m.name && m.name.includes(raw)))
          if (loose.length > 1) {
            return { error: `「${raw}」在群里像好几个：${loose.map((m) => `${m.card || m.name}（${m.qq}）`).join('、')}。给 QQ 号更准。` }
          }
          found = loose
        }
        if (found.length === 1) return { qq: found[0].qq, via: 'member', matched: found[0].card || found[0].name }
      }

      return { error: `不知道「${raw}」是哪位。可以直接给 QQ 号。` }
    }

    const remember = (qq, name, extra) => {
      const limit = Math.max(1, Math.min(MAX_NAMES, Number(settings().maxNamesPerPerson) || 6))
      const r = learnName(store(), { qq, name, maxNames: limit, ...extra })
      if (r.error) return { ok: false, message: r.error }
      save()
      return r
    }

    // ---- 工具（按当前聊天现场生成，execute 里才知道是谁在说）----

    function makeTools(chat, sessionId) {
      const chatId = String(chat?.chatId || '')
      const speaker = String(api.core.hub.turnSenders?.(sessionId)?.[0] || '')

      const learn = api.defineTool({
        name: 'nickname_learn',
        description: '记住别人是怎么称呼某个人的（比如群里大家叫他「老张」）。以后就能用这个叫法称呼他；同一个人后来的叫法会顶掉旧的。',
        properties: {
          person: { type: 'string', description: '被称呼的人：QQ 号，或者群里显示的名字' },
          nickname: { type: 'string', description: '别人对他的叫法（尽量短，一个字到几个字）' },
          evidence: { type: 'string', description: '可选：你是在哪句话里听到的，原话摘一小段' },
        },
        required: ['person', 'nickname'],
        execute: async ({ person, nickname, evidence }) => {
          if (!enabled()) return { ok: false, message: '昵称记忆关着' }
          const name = normalizeName(nickname)
          if (!name) return { ok: false, message: '要记的叫法是空的' }
          if (name.length > MAX_NAME_LEN) return { ok: false, message: `叫法太长（最多 ${MAX_NAME_LEN} 个字）` }
          const hit = await resolvePerson(chat, person)
          if (hit.error) return { ok: false, message: hit.error }
          const r = remember(hit.qq, name, {
            source: 'learn',
            by: speaker,
            chatId,
            evidence: short(evidence, 100),
          })
          if (r.ok === false) return r
          const renamed = r.renamed ? `（原来叫「${r.previous}」）` : ''
          const fresh = r.added ? '' : '（这个叫法之前记过，时间更新了一下）'
          return { ok: true, message: `记住了：${hit.qq} 以后叫「${name}」${renamed}${fresh}` }
        },
      })

      const who = api.defineTool({
        name: 'nickname_who',
        description: '查一个叫法指的是谁，或者查某个 QQ 号你是怎么称呼的。想弄清「老张」到底是谁、该不该这么叫时用。',
        properties: {
          query: { type: 'string', description: '叫法，或 QQ 号；留空就看一眼你都记着谁' },
        },
        execute: async ({ query }) => {
          if (!enabled()) return { ok: false, message: '昵称记忆关着' }
          const raw = String(query || '').trim()
          const people = listPeople(store())
          if (!people.length) return { ok: true, message: '称呼本还是空的。' }

          if (!raw) {
            const rows = people.slice(0, 30).map((p) => describe(p))
            return { ok: true, message: `你记着 ${people.length} 个人的叫法：\n${rows.join('\n')}` }
          }

          if (isQQ(raw)) {
            const person = findByQQ(store(), raw)
            return person
              ? { ok: true, message: `QQ ${raw}：${describe(person)}` }
              : { ok: true, message: `QQ ${raw} 还没有记过叫法。` }
          }

          const hits = findByName(store(), raw)
          if (!hits.length) return { ok: true, message: `称呼本里没有「${raw}」。` }
          const lines = hits.slice(0, 8).map((h) => `${describe(h.person)}${h.exact ? '' : `（近似：${h.matched}）`}`)
          const tail = hits.length > 8 ? `\n…还有 ${hits.length - 8} 个` : ''
          return { ok: true, message: `「${raw}」：\n${lines.join('\n')}${tail}` }
        },
      })

      const give = api.defineTool({
        name: 'nickname_give',
        description: '给一个你一直不知道怎么称呼的人起个顺口的叫法，记下来以后就这么叫他。',
        properties: {
          person: { type: 'string', description: '给谁起：QQ 号，或者群里显示的名字' },
          nickname: { type: 'string', description: '你想怎么叫他' },
        },
        required: ['person', 'nickname'],
        execute: async ({ person, nickname }) => {
          if (!enabled()) return { ok: false, message: '昵称记忆关着' }
          if (settings().allowSelfName === false) return { ok: false, message: '设置里关掉了「允许她自己起称呼」' }
          const name = normalizeName(nickname)
          if (!name) return { ok: false, message: '叫法是空的' }
          const hit = await resolvePerson(chat, person)
          if (hit.error) return { ok: false, message: hit.error }
          const r = remember(hit.qq, name, { source: 'self', by: speaker, chatId })
          if (r.ok === false) return r
          const renamed = r.renamed ? `（原来叫「${r.previous}」）` : ''
          return { ok: true, message: `行，以后就叫 ${hit.qq}「${name}」${renamed}` }
        },
      })

      return [learn, who, give]
    }

    api.tool(({ chat, level, sessionId }) => {
      if (chat.kind === 'system' || level === 'chat') return []
      if (!enabled()) return []
      const [learn, who, give] = makeTools(chat, sessionId)
      return settings().allowSelfName === false ? [learn, who] : [learn, who, give]
    })

    // ---- 让她知道有这么个称呼本 ----

    api.rule((kind) => {
      if (!enabled()) return ''
      const lines = [
        '你有一个称呼本：别人怎么称呼某个人、你给谁起过什么叫法，都记在里面。认人用 nickname_who，听到新叫法用 nickname_learn 记下来，拿不准是谁也可以先查。',
        kind === 'social'
          ? '群里听到别人用一个叫法指某个人、你觉得以后还用得上，就记进称呼本；同一个人后来的叫法会顶掉旧的。'
          : '',
        settings().allowSelfName !== false ? '碰上你一直不知道该怎么称呼的人，可以自己起一个顺口的记下来（nickname_give）。' : '',
      ]
      return lines.filter(Boolean)
    })

    api.context(({ chat, sessionId }) => {
      if (!enabled() || settings().injectContext === false) return ''
      const s = store()
      const lines = []
      const senders = (api.core.hub.turnSenders?.(sessionId) || []).map(String)
      for (const qq of senders) {
        const person = s.people[qq]
        if (person) lines.push(`正在跟你说话的 ${qq}，你叫他「${person.current}」`)
      }
      if (chat.kind === 'group') {
        const rows = namesOfChat(s, chat.chatId, 8).filter((row) => !senders.includes(row.qq))
        if (rows.length) lines.push(`这个群里你记着的叫法：${rows.map((row) => `${row.current}（${row.qq}）`).join('、')}`)
      }
      return lines.join('；')
    })

    // ---- 面板接口 ----

    async function bodyOf(req) {
      try {
        return (await api.core.http.body(req)) || {}
      } catch {
        return {}
      }
    }

    const panelRows = () => listPeople(store()).map((p) => ({
      qq: p.qq,
      current: p.current,
      names: p.names.map((n) => ({ name: n.name, at: n.at, source: n.source })),
      updated: p.updated,
    }))

    api.route('/list', () => ({ ok: true, people: panelRows() }))

    api.route('/set', async (req) => {
      const b = await bodyOf(req)
      const qq = String(b.qq || '').trim()
      const name = normalizeName(b.name)
      if (!isQQ(qq)) return { ok: false, message: 'QQ 号不对（5~12 位数字）' }
      if (!name) return { ok: false, message: '叫法是空的' }
      const r = remember(qq, name, { source: 'owner' })
      if (r.ok === false) return { ok: false, message: r.message }
      return {
        ok: true,
        message: r.renamed ? `以后叫「${name}」（原来叫「${r.previous}」）` : `以后叫「${name}」`,
        people: panelRows(),
      }
    })

    api.route('/remove', async (req) => {
      const b = await bodyOf(req)
      const qq = String(b.qq || '').trim()
      const name = String(b.name || '').trim()
      if (!isQQ(qq) || !name) return { ok: false, message: '缺 QQ 号或叫法' }
      if (!forgetName(store(), qq, name)) return { ok: false, message: '没记过这个叫法' }
      save()
      return { ok: true, message: `删了「${name}」`, people: panelRows() }
    })

    api.route('/forget', async (req) => {
      const b = await bodyOf(req)
      const qq = String(b.qq || '').trim()
      if (!isQQ(qq)) return { ok: false, message: 'QQ 号不对' }
      if (!forgetPerson(store(), qq)) return { ok: false, message: '没记过这个人' }
      save()
      return { ok: true, message: '这个人的叫法全忘了', people: panelRows() }
    })

    // ---- 主人命令 ----

    const overview = () => {
      const people = listPeople(store())
      if (!people.length) return '称呼本还是空的。'
      const rows = people.slice(0, 40).map((p) => `· ${describe(p)}`)
      const tail = people.length > 40 ? `\n…还有 ${people.length - 40} 个` : ''
      return `记着 ${people.length} 个人：\n${rows.join('\n')}${tail}`
    }

    api.command({
      name: '昵称',
      desc: '看她记着的称呼：/昵称、/昵称 查 老张、/昵称 设 1773199891 老张、/昵称 删 老张、/昵称 忘 1773199891',
      async run(arg, msg) {
        const text = String(arg || '').trim()
        if (!text || text === '列表' || text === '全部') return overview()
        const [head, ...rest] = text.split(/\s+/)
        const body = rest.join(' ').trim()

        if (head === '查') {
          if (!body) return '用法：/昵称 查 老张'
          const hits = findByName(store(), body)
          if (!hits.length) return `称呼本里没有「${body}」。`
          return hits.slice(0, 10).map((h) => `· ${describe(h.person)}`).join('\n')
        }

        if (head === '设') {
          const parts = body.split(/\s+/).filter(Boolean)
          if (parts.length < 2) return '用法：/昵称 设 1773199891 老张'
          const qq = parts[0]
          const name = normalizeName(parts.slice(1).join(' '))
          if (!isQQ(qq)) return '第一个要写 QQ 号，比如 /昵称 设 1773199891 老张'
          const r = remember(qq, name, { source: 'owner', by: String(msg?.userId || '') })
          if (r.ok === false) return r.message
          return `记住了：${qq} 叫「${name}」${r.renamed ? `（原来叫「${r.previous}」）` : ''}`
        }

        if (head === '删') {
          if (!body) return '用法：/昵称 删 老张'
          const hits = findByName(store(), body).filter((h) => h.exact)
          if (!hits.length) return `称呼本里没有「${body}」。`
          const changed = []
          for (const hit of hits) {
            if (forgetName(store(), hit.person.qq, hit.matched)) changed.push(`${hit.matched}（${hit.person.qq}）`)
          }
          if (!changed.length) return '没删掉。'
          save()
          return `删了：${changed.join('、')}`
        }

        if (head === '忘') {
          if (!body) return '用法：/昵称 忘 1773199891'
          if (!isQQ(body)) return '要写 QQ 号，比如 /昵称 忘 1773199891'
          if (!forgetPerson(store(), body)) return `没记过 ${body}。`
          save()
          return `把 ${body} 的叫法全忘了。`
        }

        return '用法：/昵称、/昵称 查 老张、/昵称 设 1773199891 老张、/昵称 删 老张、/昵称 忘 1773199891'
      },
    })

    return {
      /** 她现在怎么称呼这个人 */
      nameOf: (qq) => findByQQ(store(), qq)?.current || '',
      /** 这个叫法指的是谁（多个只返回第一个） */
      resolve: (name) => findByName(store(), name)[0]?.person.qq || '',
      list: () => listPeople(store()).map((p) => ({ qq: p.qq, current: p.current, names: p.names.map((n) => n.name) })),
    }
  },
}
