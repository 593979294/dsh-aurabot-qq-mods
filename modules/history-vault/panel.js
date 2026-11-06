// 跨会话历史库 · 自定义面板
// 拿到 React、h、ui（面板自带组件）、call（调模块接口），最后 return 一个 React 组件。
// 数据一律来自 /stats 和 /read，写操作只有「压缩一次」和「清空某聊天」，都不碰原文内容。

const { useState } = React

return function Panel({ settings, save, toast }) {
  const [stats, setStats] = useState(null)
  const [chatId, setChatId] = useState('')
  const [detail, setDetail] = useState(null)
  const [busy, setBusy] = useState('')

  const loadStats = async () => {
    try { setStats(await call('/stats')) } catch (e) { toast('读取统计失败：' + e.message) }
  }
  if (!stats) { loadStats() }

  const loadDetail = async () => {
    const id = chatId.trim()
    if (!id) { toast('先填聊天 ID，比如 group:123 或 private:456') ; return }
    setBusy('read')
    try { setDetail(await call('/read?chatId=' + encodeURIComponent(id) + '&lines=8')) } catch (e) { toast('读取失败：' + e.message) }
    setBusy('')
  }

  const compressOnce = async () => {
    setBusy('compress')
    try {
      const r = await call('/compress', {})
      toast(r.ok ? `压缩完成：原文 ${r.lines} 条，日摘要 ${r.days} 天，月印象 ${r.months} 月，今日调用 ${r.calls?.n ?? '?'} 次` : '压缩失败')
      loadStats()
    } catch (e) { toast('压缩失败：' + e.message) }
    setBusy('')
  }

  const forget = async () => {
    const id = chatId.trim()
    if (!id) { toast('先填要清空的聊天 ID') ; return }
    if (!confirm(`确定清空 ${id} 的全部历史？删了找不回来。`)) return
    setBusy('forget')
    try {
      const r = await call('/forget', { chatId: id })
      toast(r.message || '已清空')
      setDetail(null)
      loadStats()
    } catch (e) { toast('清空失败：' + e.message) }
    setBusy('')
  }

  return h(ui.Card, { title: '跨会话记忆' },
    h('p', { className: 'ab-note' },
      '三层归档：L0 原文 → L1 日摘要 → L2 月印象。压缩带指纹，同一批内容只花一次模型调用。'),
    h('p', { className: 'ab-note' },
      '她聊天时会自动带「最近摘要」备忘，更早的细节用 recall_history 工具查。'),

    h('div', { className: 'ab-note', style: { margin: '8px 0' } },
      stats
        ? `当前库：原文 ${stats.lines} 条 · 日摘要 ${stats.days} 天 · 月印象 ${stats.months} 月 · 今日压缩调用 ${(stats.calls && stats.calls.n) || 0} 次`
        : '统计加载中……'),
    h(ui.Btn, { onClick: loadStats, style: { marginRight: 8 } }, '刷新统计'),
    h(ui.Btn, { onClick: compressOnce, disabled: busy === 'compress' }, busy === 'compress' ? '压缩中……' : '手动压缩一次'),

    h('h4', { style: { margin: '14px 0 4px' } }, '按聊天查看 / 清空'),
    h('p', { className: 'ab-note', style: { margin: '0 0 6px' } },
      '聊天 ID 就是她聊天的「门牌号」：群聊填 群号:群号（比如 群:123456），私聊填 私聊:QQ号（比如 私聊:10001）。'),
    h('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
      h('input', {
        className: 'ab-input',
        placeholder: '群聊填 群:群号，私聊填 私聊:QQ号',
        value: chatId,
        onChange: (e) => setChatId(e.target.value),
        style: { flex: 1 },
      }),
      h(ui.Btn, { onClick: loadDetail, disabled: busy === 'read' }, '查看'),
      h(ui.Btn, { onClick: forget, disabled: busy === 'forget' }, busy === 'forget' ? '清空中……' : '清空'),
    ),
    detail && h('div', { className: 'ab-note', style: { marginTop: 8, whiteSpace: 'pre-wrap', maxHeight: 260, overflow: 'auto' } },
      detail.months?.length
        ? '【月印象】\n' + detail.months.map((m) => `${m.month}：${m.abstract}`).join('\n') + '\n\n'
        : '',
      detail.days?.length
        ? '【日摘要】\n' + detail.days.map((d) => `${d.day}：${d.abstract}`).join('\n') + '\n\n'
        : '',
      detail.lines?.length
        ? `【原文片段（最近 ${detail.lines.length} 条）】\n` + detail.lines.map((l) => `${new Date(l.t).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} ${l.who || '?'}：${l.text}`).join('\n')
        : (detail.days?.length || detail.months?.length ? '' : '这个聊天还没有归档记录。'),
    ),

    h('h4', { style: { margin: '16px 0 4px' } }, '使用教程'),
    h('div', { className: 'ab-note', style: { lineHeight: 1.9 } },
      h('div', null, '① 它记什么：她和每个聊天的每一句话（收到的、发出去的）都会自动存进本机数据库，不用你做任何事。'),
      h('div', null, '② 三层存储：原文（每句话）→ 日摘要（一天一段）→ 月印象（一月一段）。旧内容会被慢慢压缩，但压缩前原文永远留在库里，细节不丢。'),
      h('div', null, '③ 怎么省钱：压缩带「指纹」——同一段内容只压缩一次，重复整理、会话重开都不会再花模型调用。'),
      h('div', null, '④ 她怎么用：聊天时会自动带上最近几天的摘要备忘；你问「上次说的那家店」「之前约了什么」，她会用 recall_history 工具自己去翻更早的摘要和原文。'),
      h('div', null, '⑤ 会话重开也不怕：DSH 会话归档、上下文被压缩，历史库里都在。新会话第一次聊天时她能立刻接上之前的话题。'),
      h('div', null, '⑥ 查找：QQ 里发 /史库 关键词 可以按词搜所有日摘要；面板这里按聊天 ID 看全文。'),
      h('div', null, '⑦ 隐私与容量：历史按聊天隔离；群太吵可以在设置里关「记录群聊」，或用群/私聊白名单只录指定聊天；想彻底删掉某个聊天的记录，填上它的聊天 ID 点「清空」即可，删了找不回。'),
    ),
  )
}
