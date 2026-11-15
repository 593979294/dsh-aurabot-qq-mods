// panel.js —— 「我的世界服务器分身」面板。
// 由面板宿主动态执行：拿到 React、h（createElement）、ui（自带组件）、call（调模块路由），
// 最后 return 一个 React 组件。设置表单在下方自动生成（index.mjs 的 settings），这里只做状态和手动操作。

const { useState, useEffect, useCallback } = React

const dot = (ok) => h('span', {
  style: {
    display: 'inline-block', width: 8, height: 8, borderRadius: 4, marginRight: 6,
    background: ok ? '#16a34a' : '#ef4444',
  },
})

const mono = (text) => h('span', { style: { fontFamily: 'Consolas, monospace', fontSize: 12 } }, text)

const MODE_LABEL = { smart: '智能接话', wake: '只回应召唤', all: '每条都看' }

return function Panel ({ settings, draftSettings, setSettings, save, toast }) {
  const [st, setSt] = useState(null)
  const [busy, setBusy] = useState('')
  const [cmd, setCmd] = useState('')
  const [say, setSay] = useState('')

  const load = useCallback(async (refresh) => {
    try {
      const r = await call('/status' + (refresh ? '?t=' + Date.now() : ''))
      if (r && r.ok) setSt(r)
    } catch (error) {
      // 面板不因为读状态失败而白屏
    }
  }, [])

  useEffect(() => {
    load(true)
    const timer = setInterval(() => load(false), 5000)
    return () => clearInterval(timer)
  }, [])

  const act = async (label, path, body) => {
    setBusy(label)
    try {
      const r = await call(path, body)
      toast((r && r.message) || (r && r.ok === false ? '没成功' : '好了'), r && r.ok === false ? 'err' : 'ok')
      load(true)
    } catch (error) {
      toast(String((error && error.message) || error), 'err')
    } finally {
      setBusy('')
    }
  }

  // ---- 服务器自动检测 ----
  const [scan, setScan] = useState(null)
  const [scanning, setScanning] = useState(false)
  const scanNow = async () => {
    setScanning(true)
    try {
      const r = await call('/detect')
      if (r && r.ok !== false) setScan(r)
      else toast((r && r.message) || '检测失败')
    } catch (error) {
      toast(String((error && error.message) || error))
    } finally {
      setScanning(false)
    }
  }
  const switchTo = async (dir) => {
    setBusy('switch')
    try {
      const r = await call('/switch', { dir })
      toast((r && r.message) || '已切换', r && r.ok === false ? 'err' : 'ok')
      load(true)
      scanNow()
    } catch (error) {
      toast(String((error && error.message) || error), 'err')
    } finally {
      setBusy('')
    }
  }
  useEffect(() => { scanNow() }, [])

  const rcon = (st && st.rcon) || {}
  const watch = st && st.watch
  const online = (st && st.online) || []
  const recent = (st && st.recent) || []
  const cfg = (st && st.settings) || {}

  const row = (label, node) => h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', margin: '4px 0', flexWrap: 'wrap' } },
    h('span', { className: 'ab-small ab-muted', style: { minWidth: 86 } }, label),
    node)

  const recentList = recent.length
    ? h('div', { style: { marginTop: 6, maxHeight: 260, overflow: 'auto' } },
        recent.map((item, i) => h('div', {
          key: i + '-' + item.at,
          className: 'ab-small',
          style: { padding: '3px 0', borderBottom: '1px solid rgba(0,0,0,0.05)', color: item.dir === 'in' ? '#334155' : '#2563eb' },
        },
          h('span', { className: 'ab-muted' }, new Date(item.at).toLocaleTimeString('zh-CN', { hour12: false }) + ' '),
          item.dir === 'in'
            ? h('span', null, (item.admin ? '👑 ' : '') + item.player + '：' + item.text)
            : item.dir === 'event'
              ? h('span', { style: { color: '#b45309' } }, '⚰ ' + item.text)
              : h('span', null, '→ ' + item.player + '：' + item.text))))
    : h('p', { className: 'ab-note' }, '还没有记录。游戏里有人说话、或者你在这里手动发一条，都会出现在这儿。')

  return h('div', { className: 'ab-grid' },
    // ---------------- 状态 ----------------
    h(ui.Card, {
      title: '🌊 我的世界分身',
      right: h('span', { style: { display: 'flex', gap: 8 } },
        h(ui.Btn, { small: true, disabled: !!busy, onClick: () => act('test', '/status', {}) }, busy === 'test' ? '刷新中…' : '刷新状态')),
    },
      row('总开关', h('span', { className: 'ab-small' }, (cfg.enabled ? '开' : '关') + ' / 游戏内监听' + (cfg.listen ? '开' : '关'))),
      row('接话', h('span', { className: 'ab-small' }, (MODE_LABEL[cfg.chatMode] || cfg.chatMode || '智能接话') + '（被叫到必回，其余可以自己沉默）')),
      row('死亡播报', h('span', { className: 'ab-small' }, cfg.eventsEnabled ? '开（有人死了会说一句）' : '关')),
      row('RCON', h('span', { className: 'ab-small' }, dot(rcon.connected), rcon.connected ? '已连接 ' : '未连接 ', mono((rcon.host || '') + ':' + (rcon.port || '')))),
      row('日志', h('span', { className: 'ab-small' },
        dot(Boolean(watch && watch.exists)),
        watch ? (watch.exists ? '正在跟随，已读 ' + watch.lines + ' 行' : '文件不存在') : '没在跟随（监听关着或没填路径）')),
      watch && !watch.exists ? h('div', { className: 'ab-small ab-muted', style: { wordBreak: 'break-all' } }, watch.path) : null,
      row('在线', h('span', { className: 'ab-small' }, online.length ? online.join('、') : '查不到 / 没人')),
      row('人格卡', h('span', { className: 'ab-small' }, (st && st.persona && st.persona.name) || '读取中…')),
      row('必回唤醒词', h('span', { className: 'ab-small' }, (cfg.wakeWords || []).join('、') || '没设置')),
      row('其他称呼', h('span', { className: 'ab-small' }, (cfg.nicknames || []).join('、') || '没设置')),
      row('管理员', h('span', { className: 'ab-small' }, (cfg.admins || []).join('、') || '没设置')),
      row('普通玩家可用', h('span', { className: 'ab-small' }, (cfg.guestCommands || []).join('、') || '无')),
      st && st.lastError ? h('p', { className: 'ab-note' }, '⚠ ' + st.lastError) : null,
      h('p', { className: 'ab-small ab-muted', style: { marginTop: 8 } },
        '游戏里叫她的唤醒词会必回；普通聊天里被问到、聊到话题、或者随机插话时才交给她，她可以选沉默。' +
        '普通玩家可以申请：切旁观/生存、tp 到坐标、回出生点、查在线；管理员能执行更广的命令。')),

    // ---------------- 服务器自动检测 ----------------
    h(ui.Card, {
      title: '服务器自动检测',
      right: h(ui.Btn, { small: true, disabled: scanning, onClick: scanNow }, scanning ? '检测中…' : '立即检测'),
    },
      h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', margin: '4px 0', flexWrap: 'wrap' } },
        h('span', { className: 'ab-small ab-muted' }, '自动检测'),
        h(ui.Switch, {
          on: settings.autoDetect === true,
          onChange: () => setSettings && setSettings({ autoDetect: !(settings.autoDetect === true) }),
        }),
        h('span', { className: 'ab-small ab-muted' }, '换端后自动切到正在跑的服（和其他设置一起保存）')),
      h('p', { className: 'ab-small ab-muted', style: { margin: '4px 0' } },
        '扫描服务器根目录，读每个服的 server.properties，用日志时间和 RCON 试连判断谁在跑；多个服共用 25575 时选日志最新的那个。'),
      scan && scan.current
        ? h('p', { className: 'ab-small' }, '当前：' + (scan.current.serverName || scan.current.logPath || '未设置') + '（' + scan.current.port + '）')
        : null,
      scan && scan.candidates && scan.candidates.length
        ? h('div', { style: { marginTop: 4 } },
            scan.candidates.map((c) => h('div', {
              key: c.dir,
              className: 'ab-small',
              style: { display: 'flex', gap: 8, alignItems: 'center', padding: '4px 0', borderBottom: '1px solid rgba(0,0,0,0.05)' },
            },
              h('span', { style: { flex: 1, fontWeight: c.current ? 600 : 400 } },
                (c.current ? '● ' : '') + c.name + '  ·  ' + c.port +
                (c.reachable ? ' · RCON 可连' : c.rconEnabled ? ' · 连不上' : ' · 未开 RCON')),
              h('span', { className: 'ab-muted' },
                c.logAgeMs == null ? '没有日志' : c.logAgeMs < 60_000 ? '日志刚刚更新' : '日志 ' + Math.round(c.logAgeMs / 60_000) + ' 分钟前'),
              h(ui.Btn, { small: true, disabled: !!busy || c.current, onClick: () => switchTo(c.dir) }, c.current ? '当前' : '切换'))))
        : h('p', { className: 'ab-note' }, scanning ? '正在扫描…' : '还没检测到带 server.properties 的服务器'),
      scan && scan.active ? h('p', { className: 'ab-small', style: { color: '#16a34a' } }, '检测到运行中：' + scan.active.name) : null),

    // ---------------- 手动操作 ----------------
    h(ui.Card, { title: '手动操作', desc: '直接走 RCON，不过模型、也不经过聊天判断。' },
      h('div', { style: { display: 'flex', gap: 8, margin: '6px 0', flexWrap: 'wrap' } },
        h('input', {
          className: 'ab-input', style: { flex: 1, minWidth: 220 }, value: cmd,
          placeholder: '服务器命令，例如 list / gamemode spectator 玩家名',
          onChange: (e) => setCmd(e.target.value),
          onKeyDown: (e) => { if (e.key === 'Enter' && cmd.trim()) act('exec', '/exec', { command: cmd }) },
        }),
        h(ui.Btn, { disabled: !!busy || !cmd.trim(), onClick: () => act('exec', '/exec', { command: cmd }) }, busy === 'exec' ? '执行中…' : '执行')),
      h('div', { style: { display: 'flex', gap: 8, margin: '6px 0', flexWrap: 'wrap' } },
        h('input', {
          className: 'ab-input', style: { flex: 1, minWidth: 220 }, value: say, placeholder: '让「她」在服务器里说一句话',
          onChange: (e) => setSay(e.target.value),
          onKeyDown: (e) => { if (e.key === 'Enter' && say.trim()) act('say', '/say', { text: say }) },
        }),
        h(ui.Btn, { disabled: !!busy || !say.trim(), onClick: () => act('say', '/say', { text: say }) }, busy === 'say' ? '发送中…' : '发送')),
      h('p', { className: 'ab-small ab-muted' }, '这些操作会真的发到游戏里；命令不经过「禁止执行的命令」名单（面板操作等同于主人亲自执行）。')),

    // ---------------- 最近记录 ----------------
    h(ui.Card, { title: '最近在游戏里', right: h(ui.Btn, { small: true, onClick: () => load(true) }, '刷新') },
      recentList))
}
