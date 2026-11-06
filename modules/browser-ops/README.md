# 浏览器自动化（browser-ops）

封装一个带独立登录资料的专用浏览器（Edge / Chrome 优先级自动探测），经 CDP
（Chrome DevTools Protocol，Node 自带 WebSocket）提供**原子操作**级的浏览器控制能力。

## 做什么

- **专用实例**：独立 `--user-data-dir` 资料目录（放在插件数据目录
  `modules-data/browser-ops/browser-profile/`），登录一次后 Cookie 持久保存，
  和用户日常浏览器互不干扰；调试端口只听 127.0.0.1。
- **原子操作 API 面**：别的模块 `api.use('browser-ops')` 后可直接调用：
  `launch / close / status / navigate / click / clickSelector / input /
  clearInput / pressEnter / scroll / screenshot / snapshot / evaluate / show`。
  模块只提供能力，不做具体平台的业务流程（刷抖音是 douyin 模块自己的事）。
- **页面快照**：`snapshot({ mode:'dom'|'a11y', maxChars })` 返回给模型读的
  文本摘要（标题 / 可交互元素 / 正文摘要，或无障碍树）。
- **主人私聊入口**：`/browser status|open|close|goto <url>|snap|shot|show|guides` 命令，
  外加 `browser_visit` / `browser_status` 两个 AI 工具。
- **指引体系**（仿手机逛逛）：内置「主流程总纲 main」（只在浏览任务时注入，不被自动挑中）
  + 场景手册 `login`（登录）/ `search`（搜索）/ `read`（读页）/ `form`（表单）+ `generic`（通用模板）；
  自定义指引存数据目录 `guides/<key>.md`，可覆盖内置、可删除（两道确认）、总纲只能还原不可删。
  浏览任务执行前注入「总纲常驻 + 按目标关键词挑场景手册」（面板可关）。
- **面板**（自定义 panel.js）：主卡（总开关+状态+运行设置）→ 红色「高权限风险提示」卡 →
  站点白名单（可选，空 = 不限制，AI 工具与跨模块 navigate 都过这道门）→ 总纲独立卡 →
  指引列表（左列表右编辑，人格页式分节编辑）。
- **生命周期**：启动失败自动退避重试（5/10/20/40/60 分钟封顶）；DSH 重启后能
  接回还开着的窗口；模块停用 / 插件卸载时自动关闭浏览器。

## 怎么用

1. 面板打开「总开关」（默认关）。想扫码登录某网站：`/browser goto https://...`
   后发 `/browser show on` 把窗口挪进屏幕，扫完 `/browser show off` 挪回去。
2. 主人私聊直接说「帮我打开 xxx 网页看看」——她用 `browser_visit` 工具打开并回报摘要。
3. 其他模块（如 douyin）在 setup 里经 `api.use('browser-ops')` 复用同一浏览器实例。

## 安全默认值

| 项 | 默认 |
|---|---|
| 总开关 | **关**（关着时工具、命令、跨模块启动全部拒绝） |
| 仅主人 | **开**（AI 工具只在主人会话里可用） |
| 窗口位置 | 屏幕外（不抢前台，`show` 可临时挪进屏幕） |
| 登录资料 | 插件数据目录，不随模块分发，绝不写模块源码目录 |
| 调试端口 | 只听 127.0.0.1，不对局域网开放 |

## 隐私声明

模块打开的页面内容（标题/元素/正文摘要）会在工具结果里发给模型——这只走你配置的
模型接口，模块本身不向任何第三方地址发送数据；除本机 CDP 调试口外不访问任何网络。

## 许可

MIT（Aurabot，2026），见 `LICENSE`。
