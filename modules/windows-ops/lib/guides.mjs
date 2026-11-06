// guides.mjs —— windows-ops 指引提示词库（仿 phone 模块 lib/guides.mjs 的分层设计）
// 来源：aurabot 模块库 modules/windows-ops（MIT；分层结构对齐 modules/phone/lib/guides.mjs）
// 作用：给「操作这台电脑」的决策注入操作手册。分两层省 token：
//       · 总纲 main：不挂任何操作类型（resolve 永远不会自动挑它），只做常驻注入（api.rule），
//         描述整体怎么排任务、安全红线怎么守；
//       · 手册（input 键鼠 / window 窗口 / clipboard 剪贴板 / screenshot 截屏 / generic 通用）：
//         按当前操作类型按需加载（AI 用 windows_ops_guide 工具现取）。
//       自定义指引存 dataDir/guides/<key>.md，可覆盖内置、可删除（面板两道确认）；
//       main 与 generic 只能还原内置版，不能删。
// 契约：BUILTIN_GUIDES（key → { name, cat, keywords, text }）
//   createGuides(dataDir) → { list(), get(key), upsert(key, {name,text}), remove(key),
//     resolve({ op }) → key（按操作类型挑手册；op 不认识回 generic） }

import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// ---------- 内置指引（分节布局：【标题】/◆ 标题，同人格/phone 指引的节标记） ----------

/** 主流程总纲：常驻注入，不挂操作类型。 */
const MAIN_GUIDE = `【总纲 · 逛电脑主流程】
◆ 这份总纲是什么
- 它是「操作这台电脑」的章程：主人让你动电脑时（截屏/查剪贴板/切窗口/键鼠代办）都按这份总纲排任务；
  单类手册（键鼠/窗口/剪贴板/截屏）按当前操作按需追加，两边一起看，总纲优先。
◆ 总则（怎么排任务）
- 先想清楚主人要的最终结果，再拆成最少的操作步骤；每一步用 windows_ops 执行，op 一收拾一条，别把多个动作塞进一次调用。
- 优先用「安全操作」：能读剪贴板/截图/枚举窗口就别动键鼠；键鼠与关窗口是最后手段。
- 动之前先观察：不清楚界面状态就先 window.list 或 screenshot 看一眼，别盲点坐标。
◆ 安全红线
- 只做主人明确交代的事；顺手多点的每一次点击都可能发错东西。
- 关窗口（window.close）会丢未保存内容：只关主人点名的进程，绝不顺手清理「看起来没用」的窗口。
- 遇到支付、登录、验证码、删除确认这类界面：停下向主人确认，绝不代点。
- 键鼠动作落点基于当前屏幕，动完用截图或窗口列表验证一次，失败重试至多一次，仍不行就如实汇报。
◆ 收尾
- 任务做完用一句话向主人报告做了什么、结果在哪（如截图路径、剪贴板内容摘要）；中途被拦的如实说原因，别只说「完成」。`

/** 键鼠手册（cat: input，挂 mouse.move / mouse.click / key.text / key.press）。 */
const INPUT_GUIDE = `【键鼠模拟 · 操作手册】
◆ 总则
- 键鼠动作作用在「当前屏幕的真实光标/焦点」上：动之前一定先确认目标窗口在前台（window.activate 后再动）。
- 坐标原点在主屏左上角，多显示器时负坐标/超主屏坐标可能落空；不确定先 screenshot 看一眼再定坐标。
◆ 操作套路
- 点按钮：screenshot 看清位置 → mouse.move 到目标 → mouse.click；点完截图验证界面变化。
- 打字：先把目标输入框点一下（让焦点进去）→ key.text 输入内容；**中文环境大坑**：系统挂着中文输入法时，
  key.text 的字母会被输入法吃掉转拼音（真机实测 'wops' 变成「我平时」）。要可靠注入文本（尤其中文/精确内容），
  一律用「clipboard.write 写入 → paste 粘贴（Ctrl+V）」；key.text 只用于短英文/数字。
- 按键：key.press 只收固定键名（enter/tab/esc/space/backspace/delete/方向键/home/end/pageup/pagedown/f1..f12），组合键不支持。
- 右键菜单：mouse.click 传 button: right。
◆ 坑（高频翻车点）
- 中文输入法开着时 key.text 不可靠：键入结果对不上就改用 paste 重做，别反复重试 key.text。
- 窗口没在前台时点击会点到别的窗口：激活失败就别继续点，先向主人汇报。
- 屏幕缩放（DPI 150% 等）会让坐标错位：截图是像素坐标，直接用它，别自己换算。
- 弹窗/更新提示挡住目标时，先点它的「×」或按 esc 关掉再继续。
- 连续两次点击界面没变化：停下汇报，别无限重试。`

/** 窗口手册（cat: window，挂 window.*）。 */
const WINDOW_GUIDE = `【窗口管理 · 操作手册】
◆ 总则
- window.list 给出所有有主窗口的进程：pid、进程名、窗口标题；pid 是唯一凭据，操作前先从列表里认准它。
- 窗口标题通常含程序名+文档名，比进程名好认；认不准就把列表念给主人确认。
◆ 操作套路
- 切窗口：window.list 找 pid → window.activate；下一步再用 window.list/screenshot 验证已到前台。
- 关窗口：只关主人点名的进程；window.close 发的是「正常关闭消息」，程序自己收尾（未保存文档会弹确认框，那时停下问主人）。
- 找窗口：list 结果很多时，按标题关键词过滤后再报给主人，别整屏甩。
◆ 坑
- 有些进程有窗口但标题为空（后台托盘）：别把它当目标。
- window.activate 对最小化窗口会先还原再置前，但个别程序不吃系统置前（焦点被抢）：重试一次，不行就请主人手动点一下。
- system/Broken 状态进程（如以管理员跑的程序）可能关不动：如实汇报。`

/** 剪贴板手册（cat: clipboard，挂 clipboard.*）。 */
const CLIPBOARD_GUIDE = `【剪贴板 · 操作手册】
◆ 总则
- clipboard.read 返回当前剪贴板全文（可能是别人刚复制的内容）：读到的内容当着主人的面复述摘要即可，长内容别整段贴回。
- clipboard.write 会覆盖剪贴板旧内容：主人没让覆盖时先 read 一眼，里面是重要内容就先问一句。
◆ 操作套路
- 「帮我把这段复制走」：clipboard.write 写入 → 汇报完成。
- 「看看我复制的什么」：clipboard.read → 摘要复述。
- 剪贴板是空的/是二进制（截图、文件）：如实说明，别硬猜。
◆ 坑
- 读到的密码、验证码等敏感内容：只按主人要求使用，不要写进记忆或复述给别的聊天。
- 写入后想验证，可以再 read 一次比对前 20 字。`

/** 截屏手册（cat: screenshot，挂 screenshot）。 */
const SCREENSHOT_GUIDE = `【截屏 · 操作手册】
◆ 总则
- screenshot 抓的是整块虚拟桌面（多显示器全算上），存成 PNG 落在模块数据目录 shots/ 下，返回文件路径。
- 面板 /screenshot 路由可直接回图；QQ 里发图需要主人面支持发文件时再发路径。
◆ 操作套路
- 「截个屏看看」：screenshot → 报路径；主人要看内容时用 sendFile/sendImage 发过去。
- 键鼠任务前的「侦察」：动坐标前先截一张确认目标位置，比猜坐标稳得多。
◆ 坑
- 全屏截图可能带隐私内容（别的窗口、通知横幅）：只按主人要求使用与发送，别主动外传。
- 多显示器时主屏外的内容也在图里，别只看主屏。`

/** 通用手册（cat: generic，resolve 兜底；自定义指引请照三段结构仿写）。 */
const GENERIC_GUIDE = `【通用 · 操作手册（自定义指引请照此结构仿写）】
◆ 写给要自定义指引的人
- 按三段写：总则 → 操作套路 → 坑；一段都别省。
- 只描述 PowerShell 操作面（windows_ops 的 op 与参数），别写网页/ADB 的东西。
- 每条套路写成「先观察什么 → 动什么 → 怎么验证」三拍。
◆ 总则（可用操作一览）
- 安全类：clipboard.read / clipboard.write / screenshot / window.list（不需要开键鼠开关）。
- 键鼠类（要面板开「允许键鼠模拟」）：window.activate / mouse.move / mouse.click / key.text / key.press / paste。
- 文本注入优先级：可靠内容（尤其中文）用 clipboard.write + paste；key.text 只做短英文/数字（会被中文输入法吃掉转拼音）。
- 危险类：window.close（关窗口，必走主人确认门）。
◆ 操作套路（通用骨架）
- 先观察（window.list / screenshot / clipboard.read）→ 再行动（一次一个 op）→ 后验证（再观察一次对比变化）。
- 动作失败重试至多一次；还不行就把失败原因如实汇报给主人。
◆ 坑（通用安全）
- 支付、登录、验证码、删除确认界面绝不代点，停下问主人。
- 不在白名单的操作会被直接拒绝：别反复重试被拒的操作，提醒主人去面板加白名单。`

export const BUILTIN_GUIDES = {
  main: { name: '总纲·主流程', cat: '', keywords: [], text: MAIN_GUIDE },
  input: { name: '键鼠模拟', cat: 'input', keywords: ['键鼠', '点击', '打字', '鼠标', '键盘'], text: INPUT_GUIDE },
  window: { name: '窗口管理', cat: 'window', keywords: ['窗口', '切换', '激活', '关闭'], text: WINDOW_GUIDE },
  clipboard: { name: '剪贴板', cat: 'clipboard', keywords: ['剪贴板', '复制'], text: CLIPBOARD_GUIDE },
  screenshot: { name: '截屏', cat: 'screenshot', keywords: ['截图', '截屏', '屏幕'], text: SCREENSHOT_GUIDE },
  generic: { name: '通用', cat: 'generic', keywords: [], text: GENERIC_GUIDE },
}

/** key 白名单：key 直接拼 dataDir/guides/<key>.md 路径，`../../x` 越目录的一律不认。 */
const SAFE_KEY = /^[A-Za-z0-9_-]{1,40}$/

/** 读自定义覆盖层：dataDir/guides/<key>.md 存在则 text 用它，首行 `<!-- name: xxx -->` 可改名。 */
function readCustom(dataDir, key) {
  if (!SAFE_KEY.test(String(key || ''))) return null
  const p = join(dataDir, 'guides', `${key}.md`)
  if (!existsSync(p)) return null
  let text = ''
  try { text = readFileSync(p, 'utf8') } catch { return null }
  let name = ''
  text = text.replace(/^<!--\s*name:\s*(.+?)\s*-->\s*\n/, (_, n) => { name = n.trim(); return '' })
  return { name, text }
}

function writeCustom(dataDir, key, { name, text }) {
  const dir = join(dataDir, 'guides')
  mkdirSync(dir, { recursive: true })
  const head = name ? `<!-- name: ${name} -->\n` : ''
  writeFileSync(join(dir, `${key}.md`), head + String(text || ''), 'utf8')
}

export function createGuides(dataDir) {
  return {
    /** 全部指引（内置 + 自定义覆盖后的形态），source 标明来源。 */
    list() {
      const dir = join(dataDir, 'guides')
      const customKeys = existsSync(dir)
        ? readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, ''))
        : []
      const keys = [...new Set([...Object.keys(BUILTIN_GUIDES), ...customKeys])]
      return keys.map((key) => {
        const b = BUILTIN_GUIDES[key]
        const c = readCustom(dataDir, key)
        if (!b && c) return { key, name: c.name || key, source: 'custom', cat: '', keywords: [], text: c.text }
        return { key, name: c?.name || b.name, source: c ? 'custom' : 'builtin', cat: b.cat || '', keywords: b.keywords || [], text: c?.text || b.text }
      })
    },
    /** 取一条指引正文（自定义优先）；generic 永远有。 */
    get(key) {
      if (!key || key === 'generic') return BUILTIN_GUIDES.generic.text
      const c = readCustom(dataDir, key)
      if (c?.text) return c.text
      return BUILTIN_GUIDES[key]?.text || null
    },
    /** 新建/覆盖自定义指引（自定义层整体覆盖，删除即回到内置版）。 */
    upsert(key, { name, text } = {}) {
      if (!key || !/^[a-z0-9-]{2,40}$/.test(key)) throw new Error('指引 key 只能是小写字母/数字/短横线（2~40 字）')
      writeCustom(dataDir, key, { name, text })
      return { key, name: name || key, source: 'custom', cat: '', keywords: [], text: String(text || '') }
    },
    /** 删自定义层（回到内置；main/generic 是总纲与兜底，删不掉）。 */
    remove(key) {
      const k = String(key || '')
      if (k === 'main' || k === 'generic') return false
      if (!SAFE_KEY.test(k)) return false
      const p = join(dataDir, 'guides', `${k}.md`)
      if (!existsSync(p)) return false
      unlinkSync(p)
      return true
    },
    /** 按操作 id 挑手册 key：键鼠/激活 → input，窗口 → window，剪贴板 → clipboard，
     *  截屏 → screenshot；不认识回 generic。main 永远不被自动挑中（只做常驻注入）。 */
    resolve({ op = '' } = {}) {
      const o = String(op)
      if (o.startsWith('mouse.') || o.startsWith('key.') || o === 'window.activate' || o === 'paste') return 'input'
      if (o.startsWith('window.')) return 'window'
      if (o.startsWith('clipboard.')) return 'clipboard'
      if (o === 'screenshot') return 'screenshot'
      return 'generic'
    },
  }
}
