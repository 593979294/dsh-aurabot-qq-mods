// index.mjs —— windows-ops 模块入口（装配层）
// 来源：aurabot 模块库 modules/windows-ops（本仓库原创，MIT）
// 作用：把 lib/ps.mjs（PowerShell 执行底座）、lib/ops.mjs（操作目录）、lib/uia.mjs（UIA 无障碍树元素定位）、
//       lib/safety.mjs（白名单/确认/限速闸门）、lib/guides.mjs（指引库）装配成完整模块：
//       自定义面板 panel.js、AI 工具（windows_ops / windows_ops_status / windows_ops_guide /
//       windows_share_screen / windows_remote_assist）、/wops 命令、
//       /screenshot /status /ops /confirm /guides /share /assist 面板路由。
// v1.3.0 新增（「逛电脑」的共享与远程）：
//   · lib/screen.mjs —— 按主人指令把屏幕按间隔发到主人 QQ 私聊（共享屏幕）；
//   · lib/remote.mjs —— 生成一次性邀请链接，主人在手机/另一台电脑上实时看屏幕并直接操作（远程协助邀请）。
//   两者都不碰键鼠闸门：共享只截屏；远程协助的输入仍要求面板打开「允许键鼠模拟」。
// 契约：export default { id, name, version, api, settings: [], setup(api) → 导出对象 }
//   导出（api.use('windows-ops') 拿到）：
//     run(op, args) → { ok, message, data? }  —— 直接执行一个操作（不过安全闸门）
//     exec(op, args) → 同上，但过安全闸门（工具/命令都走它）
//     status() → { enabled, allowInput, dryRun, confirms, ops, whitelist, guides }
//     guides —— lib/guides.mjs 的指引库（main 总纲 + 按操作类型的手册）
//     OPS —— 操作元数据表
//   测试钩子：api.__windowsOpsTestHooks = { ps }（注入 fake ps，不打真 PowerShell）
//
// 安全模型（默认仅主人可用）：
//   · AI 工具只在主人会话放行（turnSendersAllOwner，群友同轮也不借权）；
//   · /wops 命令框架天然只认主人；
//   · 操作白名单（面板改，空 = 内置规则）+ 键鼠模拟单独开关 + 危险操作确认门槛
//     （window.close 等第一次执行只入确认队列，主人 /wops confirm 批准后一次性放行）；
//   · 数据一律落 api.dataDir()（截图 shots/、日志 logs/、自定义指引 guides/）。
//
// 指引注入（仿 phone：总纲常驻 + 手册按需，省 token）：
//   · main 总纲经 api.rule 常驻进她的规则（每轮现读，改面板即生效）；
//   · 单类手册（键鼠/窗口/剪贴板/截屏）由 AI 用 windows_ops_guide 工具按当前操作现取。

import { existsSync, readFileSync } from 'node:fs'
import { createPs } from './lib/ps.mjs'
import { createOps, OPS } from './lib/ops.mjs'
import { createSafety } from './lib/safety.mjs'
import { createGuides } from './lib/guides.mjs'
import { createScreenShare } from './lib/screen.mjs'
import { createRemoteAssist } from './lib/remote.mjs'

export default {
  id: 'windows-ops',
  name: '逛电脑（Windows 自动化）',
  version: '1.3.0',
  api: 1,
  description: '经 PowerShell 操作这台电脑：读无障碍树（UIA）按元素点击/写值/读文本/触发表单，窗口枚举/激活/关闭、截屏、剪贴板读写、键鼠模拟；并通过 QQ 向主人共享屏幕、生成一次性远程协助邀请（看屏幕/点击/输入）。默认仅主人可用，带操作白名单、危险操作确认门槛与指引体系。',
  panel: 'panel.js', // 自定义面板：settings 数组留空，全部字段由 panel.js 接管（仿 phone）
  // settings 留空：面板字段全部由 panel.js 接管（总开关挂在模块名同一行，仿 phone/B 站页）。
  // 默认值兜底两处：panel.js 的 DEFAULTS（显示用）+ 下面 getSettings()（运行时兜底）。
  settings: [],
  defaults: {
    enabled: false,
    opsWhitelist: '',
    allowInput: false,
    confirmDanger: true,
    dryRun: false,
    rateLimit: 60,
    powershellPath: '',
    preferUia: true, // 优先用元素定位（v1.2.0）：默认开，关掉则按坐标操作（兜底路径仍存在）
    // v1.3.0 共享与远程
    shareInterval: 5, // 共享屏幕：每几秒一帧
    shareQuality: 60, // 共享帧 JPEG 质量（20~95）
    shareMaxWidth: 1280, // 共享帧宽度上限（省流量）
    shareMinutes: 10, // 一次共享默认多少分钟（1~120）
    remoteAllow: false, // 远程协助总开关：默认关，关着连端口都不起
    remotePort: 17890, // 远程协助端口（1024~65535）
    remoteBind: '0.0.0.0', // 监听地址：0.0.0.0 局域网可达；127.0.0.1 只有本机
    remoteMinutes: 15, // 邀请有效期（1~60 分钟）
    remotePublicBase: '', // 对外地址（隧道/反代），留空用局域网 IP
    remoteMaxWidth: 1280, // 远程画面宽度上限
    remoteQuality: 55, // 远程画面 JPEG 质量
  },

  setup(api) {
    const dataDir = () => api.dataDir()
    /** 设置每次现读（面板改完即时生效，不缓存）。 */
    const getSettings = () => {
      const s = api.settings()
      const num = (v, d, min, max) => {
        const n = Number(v)
        return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : d
      }
      return {
        enabled: s.enabled === true, // 总开关：明确 true 才放行
        opsWhitelist: String(s.opsWhitelist || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean),
        allowInput: s.allowInput === true,
        confirmDanger: s.confirmDanger !== false, // 确认门槛默认开
        dryRun: s.dryRun === true,
        rateLimit: Number(s.rateLimit) > 0 ? Number(s.rateLimit) : 0,
        powershellPath: String(s.powershellPath || ''),
        // 元素定位优先（面板「优先用元素定位」开关）：只有明确关成 false 才按坐标走，缺省 true
        preferUia: s.preferUia !== false,
        // v1.3.0：共享屏幕与远程协助（数值范围在这里统一夹住，面板/命令/工具传什么都跑不出去）
        shareInterval: num(s.shareInterval, 5, 2, 300),
        shareQuality: num(s.shareQuality, 60, 20, 95),
        shareMaxWidth: num(s.shareMaxWidth, 1280, 320, 3840),
        shareMinutes: num(s.shareMinutes, 10, 1, 120),
        remoteAllow: s.remoteAllow === true, // 默认关：关着连端口都不起
        remotePort: num(s.remotePort, 17890, 1024, 65535),
        remoteBind: String(s.remoteBind || '0.0.0.0') === '127.0.0.1' ? '127.0.0.1' : '0.0.0.0',
        remoteMinutes: num(s.remoteMinutes, 15, 1, 60),
        remotePublicBase: String(s.remotePublicBase || '').trim(),
        remoteMaxWidth: num(s.remoteMaxWidth, 1280, 320, 3840),
        remoteQuality: num(s.remoteQuality, 55, 20, 95),
      }
    }
    const offMsg = () => ({ ok: false, message: '逛电脑总开关没开：请先到面板打开「总开关」' })

    // 测试钩子（照 pet/phone 模块 api.__xxxTestHooks 模式）：测试注入 fake ps，不打真 PowerShell
    const hooks = api.__windowsOpsTestHooks || {}
    const ps = (hooks.ps || createPs({ exe: getSettings().powershellPath }))
    const ops = createOps({ ps, dataDir: dataDir() })
    const safety = createSafety({ dataDir: dataDir(), getSettings, opsMeta: OPS })
    const guides = createGuides(dataDir())

    // ================= v1.3.0：共享屏幕（QQ 发帧）/ 远程协助（一次性邀请链接）=================
    /** 主人私聊 chatId（配置里的 ownerQQ；面板/命令要用时兜底）。 */
    const ownerChatId = () => {
      const q = String(api.config?.()?.ownerQQ || '').trim()
      return /^\d{5,12}$/.test(q) ? `private:${q}` : ''
    }
    const share = createScreenShare({
      ops,
      dataDir: dataDir(),
      getSettings,
      log: api.log,
      sendImage: (chatId, src) => api.sendImage(chatId, src),
      // 自动停（到点/连续失败）时在会话聊天里说一声；主人手动停不重复播报
      onEnd: (done) => {
        if (!done?.chatId) return
        if (!/^(到点|连续)/.test(String(done.reason || ''))) return
        api.send(done.chatId, `（屏幕共享已停止：${done.reason}）`).catch(() => {})
      },
    })
    const remote = createRemoteAssist({ ops, dataDir: dataDir(), getSettings, log: api.log })

    /** 邀请文案：链接单独一行，方便 QQ 点开；令牌不落日志、也不让模型改写。 */
    const inviteText = (r) => [
      '【远程协助邀请】主人，通道已经打开：',
      r.url,
      `有效期 ${r.minutes} 分钟，打开就能看到这台电脑的屏幕并直接点击/输入；用完发 /wops assist stop，或点页面「断开」，立刻失效。`,
      '链接等于这台电脑的临时控制权，只发给主人本人，别转发。',
    ].join('\n')

    /** 邀请后先补一张当前画面（QQ 里能立刻看到是锁屏还是桌面）。 */
    async function sendAssistPreview(chatId) {
      try {
        const cap = await ops.run('screen.capture', { maxWidth: getSettings().shareMaxWidth, quality: getSettings().shareQuality })
        if (!cap?.ok || !cap?.data?.file) return
        const buf = readFileSync(cap.data.file)
        await api.sendImage(chatId, 'base64://' + Buffer.from(buf).toString('base64'))
      } catch { /* 预览失败不影响邀请本身 */ }
    }

    // 共享屏幕的心跳：每秒调一次，只有到点才截帧（间隔/时长都由 lib/screen.mjs 管）
    // （api.every 是插件接口；单测的 fake api 不带这个面，这里按能力探测，避免装配期报错）
    if (typeof api.every === 'function') {
      api.every(1000, async () => { await share.tick() }, '共享屏幕')
      // 兜底：远程邀请到期后尽快释放端口（请求时也会判过期，这里不依赖有人访问）
      api.every(5000, async () => {
        const st = remote.status()
        if (st.active && st.remainingMs <= 0) remote.stop('邀请到期')
      }, '远程协助到期')
    }

    /** 危险操作的摘要（确认队列里给主人看）。 */
    function summaryOf(op, args) {
      const r = ops.prepare(op, args) // 未知操作/参数不对在这里抛错，正好当校验用
      return r.summary
    }

    /** 带闸门执行：工具与命令统一走这里。 */
    async function exec(op, args = {}) {
      if (!getSettings().enabled) return offMsg()
      const cp = safety.checkOp(String(op))
      if (!cp.ok) return { ok: false, message: cp.reason }
      let gate
      try {
        gate = safety.gate({ op: String(op), summary: summaryOf(op, args) })
      } catch (e) {
        return { ok: false, message: e.message }
      }
      if (gate.verdict === 'REJECT') return { ok: false, message: gate.reason || '操作被拒绝' }
      if (gate.verdict === 'DRY_RUN') return { ok: true, message: `试运行：本该执行 ${OPS[op]?.label || op}，没有真动` }
      if (gate.verdict === 'NEED_CONFIRM') {
        return { ok: false, message: `危险操作需主人确认：${OPS[op]?.label || op}（${summaryOf(op, args)}）。主人发「/wops confirm 批准 ${gate.id.slice(-6)}」后放行一次`, confirmId: gate.id }
      }
      if (!safety.checkRate()) return { ok: false, message: `操作太频繁：每分钟上限 ${getSettings().rateLimit} 次` }
      try {
        const r = await ops.run(op, args)
        safety.log(String(op), r.message).catch(() => {})
        return r
      } catch (e) {
        safety.log(String(op), `失败：${e.message}`).catch(() => {})
        return { ok: false, message: e.message }
      }
    }

    // ================= 指引注入（总纲常驻 + 手册按需）=================
    // 总纲经 rule 常驻进她的规则：每轮重新调用（设置/自定义指引改完即生效），只挂主人私聊。
    // preferUia 关掉时在总纲末尾补一句，明确本轮按坐标操作（面板开关 → 这一行即时生效）。
    api.rule('private', () => {
      const s = getSettings()
      if (!s.enabled) return ''
      const lines = ['【逛电脑总纲（操作这台电脑时必读，与按需取的手册一起看）】', guides.get('main')]
      if (!s.preferUia) lines.push('【本次设置】元素定位优先已关闭：按坐标操作（mouse.move / mouse.click），读无障碍树只用来确认界面状态。')
      lines.push('【共享与远程】主人说「给我看看屏幕 / 盯一下这个界面」→ windows_share_screen start（按间隔发到主人私聊，说 stop 就停）；主人说「邀请我远程协助 / 让你远程帮我」→ windows_remote_assist start，把返回的链接原样发给主人（链接等于临时控制权，只发主人私聊）。')
      if (!s.remoteAllow) lines.push('【本次设置】远程协助总开关关着：windows_remote_assist 会被拒，先提醒主人到面板「远程协助」卡打开开关。')
      return lines.join('\n')
    })

    // ================= 工具面（只认主人会话，群友同轮也不借权）=================
    /** 工具调用是否来自「全主人」会话（对齐 phone 模块 ownerToolCall）。 */
    function ownerToolCall(exec) {
      const sid = exec?.agent?.session?.id || exec?.session?.id || exec?.sessionId || ''
      const hub = api.core?.hub
      if (!sid || typeof hub?.turnSendersAllOwner !== 'function') return false
      try { return hub.turnSendersAllOwner(sid) === true } catch { return false }
    }
    const notOwnerMsg = () => ({ ok: false, message: '逛电脑的工具只在主人会话里可用（群友/别人的会话不能操作这台电脑）。' })

    /** windows_ops 工具描述里「怎么找元素」那半句：按 preferUia 开关动态生成（面板改完下一轮就生效）。 */
    function locateHint() {
      return getSettings().preferUia
        ? '优先用 uia.tree 读无障碍树再按元素操作（uia.click / uia.setValue / uia.invoke 按选择器精确定位），坐标点击（mouse.*）仅作兜底。'
        : '本次设置已关闭元素定位优先：按坐标操作（先 screenshot 看清位置，再 mouse.move / mouse.click）。'
    }

    api.tool((toolCtx) => [
      api.defineTool({
        name: 'windows_ops',
        description: '操作主人这台 Windows 电脑：读无障碍树（UIA）并按元素点击/写值/读文本/触发表单、读/写剪贴板、全屏截图、枚举/激活/关闭窗口、移动/点击鼠标、键入文字、按键。'
          + locateHint()
          + '只在主人要求时用；第一次用某类操作前先用 windows_ops_guide 取对应手册。',
        properties: {
          op: { type: 'string', description: `操作 id，可选：${Object.keys(OPS).join(' / ')}` },
          text: { type: 'string', description: '文本（clipboard.write / key.text 写内容；uia.setValue 要写进控件的值）' },
          pid: { type: 'number', description: '目标窗口进程号（window.activate / window.close / 全部 uia.* 用），从 window.list 取' },
          sel: { type: 'string', description: 'UIA 选择器（uia.* 用）：「键=值&&键=值」，键只能是 AutomationId / Name / ControlType / ClassName，值按前缀匹配、不支持通配。例：AutomationId=submitBtn、Name=提交&&ControlType=Button。不知道元素叫什么先用 uia.tree 看' },
          x: { type: 'number', description: '屏幕横坐标（mouse.move / mouse.click 用）' },
          y: { type: 'number', description: '屏幕纵坐标（mouse.move / mouse.click 用）' },
          button: { type: 'string', description: 'mouse.click 的键：left（默认）/ right' },
          key: { type: 'string', description: 'key.press 的键名：enter/tab/esc/space/backspace/delete/up/down/left/right/home/end/pageup/pagedown/f1..f12' },
        },
        required: ['op'],
        execute: async (args, ctx) => {
          if (!ownerToolCall(ctx)) return notOwnerMsg()
          return exec(String(args.op || ''), args)
        },
      }),
      api.defineTool({
        name: 'windows_ops_status',
        description: '看逛电脑现在能用什么：总开关/键鼠开关/待确认的危险操作/可用操作清单。主人问「你能不能操作我的电脑」时先看这个。',
        properties: {},
        execute: async (_args, ctx) => {
          if (!ownerToolCall(ctx)) return notOwnerMsg()
          const st = status()
          const confirms = st.confirms.length
            ? '\n待确认：' + st.confirms.map((c) => `${c.op}（${c.summary}）尾号 ${c.id.slice(-6)}`).join('、')
            : ''
          return { ok: true, message: `总开关${st.enabled ? '开' : '关'}，键鼠模拟${st.allowInput ? '开' : '关'}${st.dryRun ? '，试运行中' : ''}${confirms}\n可用操作：${st.ops.join(' / ')}` }
        },
      }),
      api.defineTool({
        name: 'windows_ops_guide',
        description: '取逛电脑的操作手册（怎么稳妥地用某类操作）。UIA 元素操作/键鼠/窗口/剪贴板/截屏/通用各一份；第一次执行某类操作、或动作失败重试前取一份看。',
        properties: { op: { type: 'string', description: '按要做的操作取手册：如 uia.tree / uia.click / uia.setValue / mouse.click / window.close / clipboard.read / screenshot；不认识回通用手册' } },
        required: ['op'],
        execute: async ({ op }, ctx) => {
          if (!ownerToolCall(ctx)) return notOwnerMsg()
          const key = guides.resolve({ op: String(op || '') })
          return { ok: true, message: guides.get(key) }
        },
      }),
      // ---- v1.3.0：共享屏幕（QQ 发帧）----
      api.defineTool({
        name: 'windows_share_screen',
        description: '按固定间隔把主人这台电脑的屏幕截成图片，发到主人的 QQ 私聊（主人说「给我看看屏幕」「盯一下这个界面」时用）。'
          + 'start 只发给主人私聊，默认按面板设置的间隔与时长；stop 立即停；status 看已发多少张、还剩多久。',
        properties: {
          action: { type: 'string', description: 'start 开始 / stop 停止 / status 看状态' },
          minutes: { type: 'number', description: '这次共享多少分钟（1~120，默认按面板设置，一般不用填）' },
        },
        required: ['action'],
        execute: async (args, ctx) => {
          if (!ownerToolCall(ctx)) return notOwnerMsg()
          const action = String(args.action || 'status').toLowerCase()
          if (action === 'status') {
            const st = share.status()
            return {
              ok: true,
              message: st.active
                ? `正在共享屏幕：已发 ${st.sent} 张、跳过 ${st.skipped} 帧，还剩约 ${Math.max(0, Math.ceil(st.remainingMs / 60000))} 分钟（每 ${st.intervalSec} 秒一帧）`
                : '现在没有在共享屏幕。主人说要看屏幕时用 start 开。',
            }
          }
          if (action === 'stop') {
            const r = share.stop('主人让停')
            return { ok: r.ok, message: r.message }
          }
          if (action === 'start') {
            const chat = toolCtx?.chat || {}
            if (chat.kind !== 'private') return { ok: false, message: '共享屏幕只往主人私聊发，群里不发' }
            if (!getSettings().enabled) return { ok: false, message: '逛电脑总开关没开：先到面板打开「总开关」' }
            if (!chat.chatId) return { ok: false, message: '拿不到当前私聊的 chatId，换在主人私聊里再试' }
            const r = share.start({ chatId: chat.chatId, minutes: args.minutes })
            if (r.ok) await share.tick() // 先发一帧，主人不用等一个间隔
            return { ok: r.ok, message: r.message }
          }
          return { ok: false, message: 'action 只能是 start / stop / status' }
        },
      }),
      // ---- v1.3.0：远程协助邀请（一次性链接，主人用浏览器接管）----
      api.defineTool({
        name: 'windows_remote_assist',
        description: '生成一条远程协助邀请：主人在手机/另一台电脑上打开链接，就能实时看这台电脑的屏幕并直接点击、输入（主人说「邀请我远程协助」「让你远程帮我」「把电脑交给我」时用）。'
          + '需要面板打开「允许远程协助」；默认 15 分钟、一次性；start 会把链接和一张当前画面发到主人私聊。',
        properties: {
          action: { type: 'string', description: 'start 生成邀请 / stop 关闭通道 / status 看状态' },
          minutes: { type: 'number', description: '有效期多少分钟（1~60，默认按面板设置）' },
        },
        required: ['action'],
        execute: async (args, ctx) => {
          if (!ownerToolCall(ctx)) return notOwnerMsg()
          const action = String(args.action || 'status').toLowerCase()
          if (action === 'status') {
            const st = remote.status()
            return {
              ok: true,
              message: st.active
                ? `远程协助开着：${st.url}（还剩约 ${Math.max(0, Math.ceil(st.remainingMs / 60000))} 分钟，已操作 ${st.actions} 次，端口 ${st.port}）`
                : '现在没有开着的远程协助邀请。',
            }
          }
          if (action === 'stop') {
            const r = remote.stop('主人让停')
            return { ok: r.ok, message: r.message }
          }
          if (action === 'start') {
            const chat = toolCtx?.chat || {}
            if (chat.kind !== 'private') return { ok: false, message: '邀请链接只往主人私聊发，群里不发' }
            if (!getSettings().enabled) return { ok: false, message: '逛电脑总开关没开：先到面板打开「总开关」' }
            if (!chat.chatId) return { ok: false, message: '拿不到当前私聊的 chatId，换在主人私聊里再试' }
            const r = await remote.invite({ minutes: args.minutes })
            if (!r.ok) return { ok: false, message: r.message }
            await api.sendText(chat.chatId, inviteText(r)).catch(() => {})
            await sendAssistPreview(chat.chatId)
            return { ok: true, message: `远程协助邀请已发到主人私聊（${r.minutes} 分钟有效）：${r.url}` }
          }
          return { ok: false, message: 'action 只能是 start / stop / status' }
        },
      }),
    ])

    // ================= /wops 命令（框架只认主人）=================
    api.command({
      name: 'wops',
      desc: '逛电脑：ops / status / shot / share 开始|停止 / assist 开始|停止 / confirm 批准|拒绝 <尾号>',
      async run(arg, msg) {
        const [verb, ...rest] = arg.trim().split(/\s+/)
        try {
          switch (verb) {
            case 'ops': {
              const lines = Object.entries(OPS).map(([k, m]) => `${k}｜${m.label}｜${m.danger === 'safe' ? '安全' : m.danger === 'input' ? '键鼠（要开开关）' : '危险（要确认）'}`)
              const wl = getSettings().opsWhitelist
              return lines.join('\n') + (wl.length ? `\n当前白名单：${wl.join('、')}` : '\n白名单未设置 = 按上面的开关规则放行')
            }
            case 'status':
              return JSON.stringify(status(), null, 2)
            case 'shot': {
              const r = await exec('screenshot', {})
              return r.message
            }
            // ---- v1.3.0：/wops share —— 按主人指令把屏幕发到 QQ 私聊 ----
            case 'share': {
              const sub = String(rest[0] || '').toLowerCase()
              if (sub === 'stop' || sub === '停止') return share.stop('主人停止').message
              if (sub === 'status' || sub === '状态') {
                const st = share.status()
                return st.active
                  ? `共享中：已发 ${st.sent} 张、跳过 ${st.skipped} 帧，还剩约 ${Math.max(0, Math.ceil(st.remainingMs / 60000))} 分钟（每 ${st.intervalSec} 秒一帧）`
                  : '现在没有在共享屏幕。发 /wops share [分钟] 开始（只发主人私聊）。'
              }
              if (msg?.kind !== 'private') return '共享屏幕只往主人私聊发，群里不发。'
              if (!getSettings().enabled) return '逛电脑总开关没开：先到面板打开「总开关」'
              const mins = Number(sub)
              const r = share.start({ chatId: msg.chatId, minutes: Number.isFinite(mins) && mins > 0 ? mins : undefined })
              if (r.ok) await share.tick() // 先发一帧
              return r.message
            }
            // ---- v1.3.0：/wops assist —— 生成一次性远程协助邀请（链接私聊发主人）----
            case 'assist': {
              const sub = String(rest[0] || '').toLowerCase()
              if (sub === 'stop' || sub === '停止') return remote.stop('主人停止').message
              if (sub === 'status' || sub === '状态') {
                const st = remote.status()
                return st.active
                  ? `远程协助开着：${st.url}（还剩约 ${Math.max(0, Math.ceil(st.remainingMs / 60000))} 分钟，已操作 ${st.actions} 次）`
                  : '现在没有开着的远程协助。发 /wops assist [分钟] 生成邀请（只在主人私聊可用）。'
              }
              if (msg?.kind !== 'private') return '远程协助邀请只发主人私聊，群里不发。'
              if (!getSettings().enabled) return '逛电脑总开关没开：先到面板打开「总开关」'
              const mins = Number(sub)
              const r = await remote.invite({ minutes: Number.isFinite(mins) && mins > 0 ? mins : undefined })
              if (!r.ok) return r.message
              await api.sendText(msg.chatId, inviteText(r)).catch(() => {})
              await sendAssistPreview(msg.chatId)
              return `远程协助已开启（${r.minutes} 分钟有效）：${r.url}`
            }
            case 'confirm': {
              const [sub, tail] = rest
              const list = safety.listConfirms()
              if (!sub || sub === 'list') {
                return list.length
                  ? list.map((c, i) => `${i + 1}. ${c.op}（${c.summary}）尾号 ${c.id.slice(-6)}`).join('\n')
                  : '没有待确认的危险操作。'
              }
              const item = list.find((c) => c.id.endsWith(String(tail || '')))
              if (!item) return '尾号不对，先发 /wops confirm 看列表。'
              if (sub === '批准' || sub === 'approve') {
                safety.approveConfirm(item.id)
                safety.log('confirm', `批准 ${item.op} ${item.summary}`).catch(() => {})
                return `已批准：${item.op}（${item.summary}）。下一次同动作直接放行。`
              }
              if (sub === '拒绝' || sub === 'reject') {
                safety.rejectConfirm(item.id)
                return `已拒绝：${item.op}（${item.summary}）`
              }
              return '用法：/wops confirm [批准|拒绝 <尾号>]'
            }
            case '':
              return '用法：/wops ops|status|shot|share [分钟|stop]|assist [分钟|stop]|confirm ...'
            default:
              return `未知子命令 ${verb}`
          }
        } catch (e) {
          return `出错了：${e.message}`
        }
      },
    })

    // ================= 面板路由（精确匹配；/screenshot 回 PNG 二进制）=================
    api.route('/screenshot', async (req, res) => {
      if (!getSettings().enabled) return { ok: false, error: '总开关没开' }
      try {
        const r = await exec('screenshot', {})
        if (!r.ok) return { ok: false, error: r.message }
        const file = String(r.data || '')
        if (!file.startsWith(dataDir()) || !existsSync(file)) return { ok: false, error: '截图文件不在数据目录，拒绝读取' }
        return api.core.http.send(res, 200, readFileSync(file), 'image/png')
      } catch (e) {
        return { ok: false, error: e.message }
      }
    })
    api.route('/status', async () => {
      const st = status()
      return { ...st, confirms: st.confirms.map((c) => ({ id: c.id.slice(-6), op: c.op, summary: c.summary, at: c.at })) }
    })
    /** 操作目录：白名单卡的「加入」按钮数据源。 */
    api.route('/ops', async () => {
      const s = getSettings()
      return { ok: true, ops: Object.entries(OPS).map(([id, m]) => ({ id, label: m.label, danger: m.danger })), whitelist: s.opsWhitelist }
    })
    api.route('/confirm', async (req) => {
      if (req.method === 'GET') return { ok: true, confirms: safety.listConfirms().map((c) => ({ id: c.id.slice(-6), op: c.op, summary: c.summary, at: c.at })) }
      if (req.method !== 'POST') return { ok: false, error: '只支持 POST' }
      const body = await api.core.http.body(req).catch(() => ({}))
      const list = safety.listConfirms()
      const item = list.find((c) => c.id.endsWith(String(body.id || '')))
      if (!item) return { ok: false, error: '没有这个待确认项' }
      if (body.approve) { safety.approveConfirm(item.id); safety.log('confirm', `批准 ${item.op} ${item.summary}`).catch(() => {}); return { ok: true } }
      if (body.reject) { safety.rejectConfirm(item.id); return { ok: true } }
      return { ok: false, error: '需要 { approve|reject, id }' }
    })
    // ---- v1.3.0：共享屏幕（面板开/停/看状态；POST 里 chatId 可覆盖，缺省用配置里的主人 QQ）----
    api.route('/share', async (req) => {
      if (req.method === 'GET') return { ok: true, ...share.status() }
      if (req.method !== 'POST') return { ok: false, error: '只支持 GET/POST' }
      const body = await api.core.http.body(req).catch(() => ({}))
      const action = String(body.action || 'status')
      if (action === 'stop') {
        const r = share.stop('面板停止')
        return { ok: r.ok, message: r.message, ...share.status() }
      }
      if (action === 'start') {
        if (!getSettings().enabled) return { ok: false, error: '总开关没开：先打开「总开关」再共享屏幕' }
        const chatId = String(body.chatId || ownerChatId() || '')
        if (!chatId) return { ok: false, error: '配置里没有主人 QQ：先在插件设置里填主人 QQ，或在私聊里发 /wops share' }
        const r = share.start({ chatId, minutes: body.minutes })
        if (r.ok) await share.tick() // 先发一帧
        return { ok: r.ok, message: r.message, ...share.status() }
      }
      return { ok: true, ...share.status() }
    })
    // ---- v1.3.0：远程协助（面板生成邀请/停止/看状态；邀请链接同时私聊发给主人）----
    api.route('/assist', async (req) => {
      if (req.method === 'GET') return { ok: true, ...remote.status() }
      if (req.method !== 'POST') return { ok: false, error: '只支持 GET/POST' }
      const body = await api.core.http.body(req).catch(() => ({}))
      const action = String(body.action || 'status')
      if (action === 'stop') {
        const r = remote.stop('面板停止')
        return { ok: r.ok, message: r.message, ...remote.status() }
      }
      if (action === 'start') {
        if (!getSettings().enabled) return { ok: false, error: '总开关没开：先打开「总开关」再开远程协助' }
        const chatId = String(body.chatId || ownerChatId() || '')
        const r = await remote.invite({ minutes: body.minutes })
        if (!r.ok) return { ok: false, error: r.message }
        if (chatId) {
          await api.sendText(chatId, inviteText(r)).catch(() => {})
          await sendAssistPreview(chatId)
        }
        return { ok: true, message: chatId ? '邀请链接已私聊发给主人' : '已生成邀请（配置里没有主人 QQ，链接只显示在这里）', url: r.url, ...remote.status() }
      }
      return { ok: true, ...remote.status() }
    })

    // ---- 指引提示词库：面板查看/编辑自定义指引（路由形态对齐 phone /guides）----
    api.route('/guides', async (req) => {
      if (req.method === 'GET') return { guides: guides.list() }
      if (req.method === 'POST') {
        const body = await api.core.http.body(req).catch(() => ({}))
        try {
          if (body.reset) return { ok: guides.remove(String(body.key || '')) }
          if (body.del) { // 删除自定义指引（总纲 main / 兜底 generic 不可删，只能还原内置版）
            const k = String(body.key || '')
            if (k === 'main' || k === 'generic') return { ok: false, error: '总纲与通用手册不可删除，只能还原成内置版' }
            return { ok: guides.remove(k) }
          }
          const g = guides.upsert(String(body.key || ''), { name: body.name, text: body.text })
          return { ok: true, guide: { key: g.key, name: g.name, source: 'custom' } }
        } catch (e) { return { ok: false, error: e.message } }
      }
      return { ok: false }
    })

    /** 导出的状态（工具/命令/路由共用）。 */
    function status() {
      const s = getSettings()
      return {
        enabled: s.enabled,
        allowInput: s.allowInput,
        dryRun: s.dryRun,
        rateLimit: s.rateLimit,
        whitelist: s.opsWhitelist,
        preferUia: s.preferUia,
        confirms: safety.listConfirms(),
        ops: Object.keys(OPS),
        guides: guides.list().map((g) => ({ key: g.key, name: g.name, source: g.source })),
        platform: process.platform,
        // v1.3.0：共享与远程的状态总览（面板/命令看同一份）
        share: share.status(),
        remote: remote.status(),
      }
    }

    // 模块停下：释放共享定时任务与远程协助端口（api.every 的定时器由框架自动撤）
    api.onDispose(() => {
      try { share.stop('模块停下') } catch { /* 已经停了 */ }
      try { remote.dispose() } catch { /* 已经关了 */ }
    })

    // setup 返回导出对象（别的模块 api.use('windows-ops') 拿到）
    return {
      run: (op, args) => ops.run(op, args),
      exec,
      status,
      guides,
      OPS,
      // 危险操作确认队列（供宿主面板/可信模块代批；真正的主人确认走 /wops confirm 或面板）
      confirm: { list: () => safety.listConfirms(), approve: (id) => safety.approveConfirm(id), reject: (id) => safety.rejectConfirm(id) },
      // v1.3.0：共享屏幕 / 远程协助（别的模块要复用可以拿这两个句柄）
      share,
      remote,
    }
  },
}
