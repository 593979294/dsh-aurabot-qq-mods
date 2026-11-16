// panel.js —— 私人日记面板：状态 + 一本可以翻的日记本
// 拿到 React、h（React.createElement）、ui（面板组件）、call（调 api.route），返回一个 React 组件。
const { useState, useCallback, useEffect, useRef } = React

const HAND_TITLE = '"ld-hand","STKaiti","华文楷体","KaiTi",serif'
const HAND_BODY = '"ld-hand","STKaiti","华文楷体","KaiTi","楷体",serif'

const fmtTime = (at) => {
  const d = new Date(Number(at) || Date.now())
  const two = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`
}
const totalChars = (items) => items.reduce((sum, x) => sum + (Number(x.chars) || 0), 0)
const dayLabel = (day) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || ''))
  return m ? `${Number(m[2])}月${Number(m[3])}日` : String(day || '')
}

// **粗体** / 标题 / 列表 的极简处理：日记是 markdown，摊在纸上不该露出星号
const inline = (text) => {
  const out = []
  String(text).split('**').forEach((seg, i) => {
    if (!seg) return
    out.push(i % 2 ? h('b', { key: i, style: { fontWeight: 700 } }, seg) : seg)
  })
  return out
}
const blocks = (body) => String(body || '').split(/\r?\n/).map((line, i) => {
  const t = line.trim()
  if (!t) return h('div', { key: i, style: { height: 32 } })
  const hd = /^#{1,6}\s+(.*)$/.exec(t)
  if (hd) return h('div', { key: i, style: { fontSize: 22, fontWeight: 700, color: '#6f5324', letterSpacing: 1 } }, inline(hd[1]))
  const li = /^[-*+]\s+(.*)$/.exec(t)
  if (li) return h('div', { key: i }, '· ', inline(li[1]))
  return h('div', { key: i }, inline(t))
})

const CSS = `
@font-face{font-family:'ld-hand';src:url('/aurabot/api/ext/local-diary/hand.ttf') format('truetype');font-display:swap;}
.ld-wrap{--ld-paper:#fdfaf0;--ld-ink:#3d3327;--ld-faint:#9c8a6a;--ld-edge:rgba(150,130,95,.45);}
/* 字体只画在日记本里，外面的状态卡片和按钮保持面板原样 */
.ld-tabs{display:flex;gap:6px;overflow-x:auto;padding:2px 6px 0;scrollbar-width:thin;}
.ld-tab{flex:0 0 auto;padding:6px 13px 7px;border:1px solid var(--ld-edge);border-bottom:none;border-radius:9px 9px 0 0;background:linear-gradient(#f0e7d3,#e5dac2);color:#7a6747;font-family:${HAND_BODY};font-size:13.5px;line-height:1.3;cursor:pointer;white-space:nowrap;transition:background .12s,color .12s;position:relative;top:1px;}
.ld-tab:hover{background:linear-gradient(#f8f1e0,#ece2cb);}
.ld-tab.on{background:var(--ld-paper);color:#8a6b34;top:2px;font-weight:700;}
.ld-tab .ld-dot{display:inline-block;width:5px;height:5px;border-radius:50%;background:#c9776a;margin-left:5px;vertical-align:2px;}
.ld-book{display:flex;background:linear-gradient(90deg,#ded4be,#d3c8b0);border-radius:2px 10px 12px 6px;box-shadow:0 14px 30px rgba(72,52,28,.20),0 1px 0 rgba(255,255,255,.6) inset;overflow:hidden;font-family:${HAND_BODY};}
.ld-rings{flex:0 0 40px;position:relative;background:linear-gradient(90deg,#cdc2a9,#ded4be 55%,#c4b89e);box-shadow:1px 0 0 rgba(120,105,80,.25) inset;}
.ld-rings i{position:absolute;left:11px;width:19px;height:27px;border-radius:10px;border:2px solid #a29a86;background:linear-gradient(#fffdf6,#e8e1cf);box-shadow:0 1px 2px rgba(90,70,40,.22),0 -1px 1px rgba(255,255,255,.9) inset;}
.ld-page{flex:1;min-width:0;background:var(--ld-paper);display:flex;flex-direction:column;max-height:620px;}
.ld-head{padding:16px 24px 9px 30px;border-bottom:1px solid rgba(150,130,95,.28);background:linear-gradient(#fdfaf0,#fbf6ea);position:relative;}
.ld-date{font-family:${HAND_TITLE};font-size:27px;line-height:1.15;color:#7a5f2e;letter-spacing:2px;}
.ld-sub{font-size:12.5px;color:var(--ld-faint);margin-top:2px;letter-spacing:.5px;}
.ld-stamp{position:absolute;right:22px;top:14px;width:56px;height:56px;border:2px solid rgba(190,86,76,.55);border-radius:50%;color:rgba(190,86,76,.72);font-size:12px;line-height:1.15;display:flex;align-items:center;justify-content:center;text-align:center;transform:rotate(-11deg);letter-spacing:1px;font-family:${HAND_TITLE};}
.ld-body{flex:1;overflow:auto;padding:8px 26px 26px 48px;color:var(--ld-ink);font-size:19px;line-height:32px;
  background-image:linear-gradient(to right,transparent 30px,rgba(206,96,96,.42) 30px,rgba(206,96,96,.42) 31px,transparent 31px),repeating-linear-gradient(to bottom,transparent 0 31px,rgba(96,128,180,.17) 31px 32px);
  background-position:0 8px,0 8px;background-attachment:local,local;background-repeat:repeat,repeat;}
.ld-body::-webkit-scrollbar{width:9px;}
.ld-body::-webkit-scrollbar-thumb{background:rgba(150,130,95,.35);border-radius:5px;}
.ld-empty{padding:26px 26px 30px 48px;color:var(--ld-faint);font-size:17px;line-height:32px;}
.ld-foot{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:7px 16px 8px 18px;border-top:1px solid rgba(150,130,95,.28);background:linear-gradient(#fbf6ea,#f5eedd);font-size:12.5px;color:var(--ld-faint);}
.ld-wish{flex:0 0 auto;display:flex;align-items:baseline;gap:10px;padding:9px 26px 10px 48px;border-top:1px dashed rgba(150,130,95,.4);background:linear-gradient(#fdf9ee,#faf2e0);}
.ld-wish .ld-wish-k{flex:0 0 auto;font-family:${HAND_TITLE};font-size:12.5px;letter-spacing:2px;color:#b0665c;}
.ld-wish .ld-wish-t{flex:1;font-family:${HAND_BODY};font-size:17px;line-height:1.65;color:#7b5f3a;word-break:break-word;}
.ld-tab .ld-star{margin-left:4px;font-size:10px;color:#c08a3e;opacity:.8;vertical-align:1px;}

.ld-flip{font-family:${HAND_BODY};font-size:13px;color:#7a6747;background:linear-gradient(#fdfaf0,#efe6d2);border:1px solid var(--ld-edge);border-radius:7px;padding:3px 11px;cursor:pointer;}
.ld-flip:hover{background:linear-gradient(#fff,#f5ecd8);}
.ld-flip:disabled{opacity:.42;cursor:default;}
`

return function Panel({ toast, settings, draftSettings, setSettings, save }) {
  const [data, setData] = useState(null)
  const [page, setPage] = useState(0)
  const [entry, setEntry] = useState(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  // 设置了但是还没保存：页面底部的浮动条常常在屏幕外面，这里也放一个按钮
  const canSave = typeof save === 'function' && draftSettings
  const draftDirty = canSave && JSON.stringify(draftSettings) !== JSON.stringify(settings || {})
  const saveNow = async () => {
    if (typeof save !== 'function') return
    try { await save(draftSettings || {}) } catch (e) { quietToast(e && e.message) }
  }
  const quietToast = (m) => { try { toast && toast(String(m || '保存失败'), 'err') } catch {} }

  const load = useCallback(async () => {
    try {
      setErr('')
      const r = await call('/status')
      if (!r || !r.ok) throw new Error((r && r.message) || '读取失败')
      setData(r)
      return r
    } catch (e) {
      setErr(String((e && e.message) || e))
      return null
    }
  }, [])

  const open = useCallback(async (file) => {
    if (!file) { setEntry(null); return }
    setLoading(true)
    try {
      const r = await call('/read', { file })
      if (r && r.ok) setEntry(r)
      else setErr((r && r.message) || '读不到')
    } catch (e) {
      setErr(String((e && e.message) || e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const items = (data && data.items) || []
  const firstFile = items.length > 0 ? items[0].file : ''
  const tabRefs = useRef([])
  // 翻页时把当前那枚书签滚到视野里，免得按钮翻到看不见的页
  useEffect(() => {
    const el = tabRefs.current[page]
    if (el && el.scrollIntoView) {
      try { el.scrollIntoView({ inline: 'center', block: 'nearest' }) } catch (error) {}
    }
  }, [page, items.length])
  useEffect(() => {
    if (!entry && firstFile) open(firstFile)
  }, [firstFile, entry, open])

  const goto = useCallback((i) => {
    const it = items[i]
    if (!it) return
    setPage(i)
    open(it.file)
  }, [items, open])

  const write = async () => {
    if (busy) return
    setBusy(true)
    try {
      const r = await call('/run', {})
      if (r && r.ok) {
        if (toast) toast(r.message || '写好了')
        setEntry(null)
        setPage(0)
        await load()
      } else {
        setErr((r && r.message) || '没写成')
      }
    } catch (e) {
      setErr(String((e && e.message) || e))
    } finally {
      setBusy(false)
    }
  }

  const openFolder = async () => {
    try {
      const r = await call('/open')
      if (r && r.ok && toast) toast('已打开：' + r.message)
    } catch (e) {
      setErr(String((e && e.message) || e))
    }
  }

  const today = new Date()
  const two = (n) => String(n).padStart(2, '0')
  const todayKey = `${today.getFullYear()}-${two(today.getMonth() + 1)}-${two(today.getDate())}`
  const wroteToday = items.some((x) => x.day === todayKey)
  const cur = entry || null

  const rings = []
  for (let i = 0; i < 9; i++) rings.push(h('i', { key: i, style: { top: `${6 + i * 10.5}%` } }))

  const book = items.length === 0
    ? h('div', { className: 'ld-book' },
        h('div', { className: 'ld-rings' }, rings),
        h('div', { className: 'ld-page' },
          h('div', { className: 'ld-head' },
            h('div', { className: 'ld-date' }, '还没有开头'),
            h('div', { className: 'ld-sub' }, '点上面「现在写一篇」，或者等晚上自己写'),
          ),
          h('div', { className: 'ld-empty' }, '这一页还空着。'),
        ),
      )
    : h('div', { className: 'ld-book' },
        h('div', { className: 'ld-rings' }, rings),
        h('div', { className: 'ld-page' },
          h('div', { className: 'ld-head' },
            h('div', { className: 'ld-date' }, dayLabel(cur ? cur.day : items[page] && items[page].day)),
            h('div', { className: 'ld-sub' },
              [
                cur && cur.day ? cur.day : (items[page] && items[page].day) || '',
                cur ? `${cur.chars || 0} 字` : '',
                (cur && cur.mood) || (items[page] && items[page].mood) || '',
                loading ? '翻页中…' : '',
              ].filter(Boolean).join('　·　')),
            cur && cur.mood ? h('div', { className: 'ld-stamp' }, cur.mood) : null,
          ),
          cur
            ? h('div', { className: 'ld-body' }, blocks(cur.body))
            : h('div', { className: 'ld-empty' }, loading ? '翻页中…' : '这一页还没打开。'),
          (cur && cur.wish) || (items[page] && items[page].wish)
            ? h('div', { className: 'ld-wish' },
                h('span', { className: 'ld-wish-k' }, '愿望'),
                h('span', { className: 'ld-wish-t' }, (cur && cur.wish) || items[page].wish))
            : null,
          h('div', { className: 'ld-foot' },
            h('button', {
              className: 'ld-flip',
              onClick: () => goto(Math.max(0, page - 1)),
              disabled: page <= 0,
              title: '更新的一篇（书签往左）',
            }, '← 更新'),
            h('span', null, `第 ${page + 1} / ${items.length} 页　·　共 ${totalChars(items)} 字`),
            h('button', {
              className: 'ld-flip',
              onClick: () => goto(Math.min(items.length - 1, page + 1)),
              disabled: page >= items.length - 1,
              title: '更早的一篇（书签往右）',
            }, '更早 →'),
          ),
        ),
      )

  return h('div', { className: 'ld-wrap' },
    h('style', { key: 'ld-css' }, CSS),

    h(ui.Card, { title: '私人日记' },
      h('div', { className: 'ab-small', style: { marginBottom: 8 } },
        `下一篇：${(data && data.next) || '—'}　·　今天${wroteToday ? '写过了' : '还没写'}　·　共 ${(data && data.count) || 0} 篇`),
      h('div', { className: 'ab-small ab-muted', style: { marginBottom: 6, wordBreak: 'break-all' } },
        `文件夹：${(data && data.folder) || '—'}`),
      data && data.folder && data.mirrorDir && !data.folder.startsWith(data.mirrorDir)
        ? h('div', { className: 'ab-small ab-muted', style: { marginBottom: 6, wordBreak: 'break-all' } },
            `备份镜像：${data.mirrorDir}`)
        : null,
      h(ui.Row, null,
        h(ui.Btn, { onClick: write, disabled: busy || (data && data.running) }, busy ? '写着…' : '现在写一篇'),
        h(ui.Btn, { onClick: load }, '刷新'),
        h(ui.Btn, { onClick: openFolder }, '打开文件夹'),
        draftDirty ? h(ui.Btn, { onClick: saveNow }, '保存设置') : null,
      ),
      draftDirty
        ? h('div', { className: 'ab-small ab-note', style: { marginTop: 8 } }, '上面的设置改了还没保存，点「保存设置」或者按 Ctrl + S。')
        : null,
      err ? h('p', { className: 'ab-note', style: { marginTop: 8 } }, '出错了：' + err) : null,
    ),

    h(ui.Card, { title: '日记本' },
      items.length > 0
        ? h('div', { className: 'ld-tabs' },
            items.map((it, i) => h('div', {
              key: it.file || i,
              ref: (el) => { tabRefs.current[i] = el },
              className: 'ld-tab' + (i === page ? ' on' : ''),
              onClick: () => goto(i),
              title: `${fmtTime(it.at)}　${it.wish ? '愿望：' + it.wish : (it.summary || '')}`,
            },
              dayLabel(it.day),
              it.mood ? h('span', { style: { opacity: .7 } }, '　' + it.mood) : null,
              it.wish ? h('span', { className: 'ld-star' }, '✦') : null,
              it.day === todayKey ? h('span', { className: 'ld-dot' }) : null,
            )))
        : null,
      book,
      cur
        ? h('div', { className: 'ab-small ab-muted', style: { marginTop: 8, wordBreak: 'break-all' } },
            `${fmtTime(cur.at)} 写　·　${cur.file || ''}`)
        : null,
    ),
  )
}
