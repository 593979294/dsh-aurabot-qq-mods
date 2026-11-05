# 米家智控（mijia）

让 QQ 里的她能看米家设备、开灯关插座。第一版只做**设备列表**和**开/关**（灯、插座、开关类），
亮度色温、场景自动化等以后再说。

**v1.1.0 起走米家 APP 现行加密通道**（`api.mijia.tech`，RC4 加密请求），并改为**扫码登录**：
不再需要账号密码，也不再触发短信二次验证。协议事实参考公开抓包笔记
[imkero/mihome-app-api](https://imkero.net/posts/mihome-app-api/) 与开源项目
[Do1e/mijia-api](https://github.com/Do1e/mijia-api)（GPL-3.0，仅作协议对照，未搬运代码），特此致谢。

## 用法

| 入口 | 例子 |
| --- | --- |
| `/米家` 命令（只认主人） | `/米家 列表`、`/米家 开 客厅灯`、`/米家 关 插座` |
| 私聊自然消息 | 「米家设备」「开 客厅灯」「关掉 插座」 |
| 让她自己动手 | 「把客厅灯关了」——她会调 `mijia_control` 工具 |
| 面板设备页 | 列出全部设备（按型号分类型），在线设备直接点「开/关」手动控制，可一键刷新列表 |

权限：主人永远可用；面板「授权名单」里每行一个 QQ 号可获授权；「仅私聊可用」默认开（群聊不碰设备）。

## 登录（扫码，无账号密码）

1. 面板点「扫码登录」，二维码直接显示在卡里；
2. 打开米家 APP 扫一扫（或手机点二维码下方链接）确认；
3. 登录凭证（passToken/serviceToken）缓存在本机数据目录，30 天内静默续期，无需重复扫码。

## 设置

- **总开关**：默认关（连云端的模块，不开不连网）
- **授权名单**：每行一个 QQ 号
- **仅私聊可用**：默认开
- **设备缓存秒数**：默认 300 秒，少敲云端、兼防风控

## 会访问哪些网址

| 网址 | 干什么 |
| --- | --- |
| `account.xiaomi.com` | 小米账号扫码登录（领二维码 / 长轮询 / 换 serviceToken / passToken 续期） |
| `api.mijia.tech` | 米家设备列表、miot 规格指令下发（RC4 加密请求） |
| `miot-spec.org` | 查设备型号的「开关」属性定义（siid/piid），结果落盘缓存 |

登录令牌（ssecurity/serviceToken/passToken）只存在本机插件数据目录（`modules-data/mijia/`），
**不上传任何第三方地址**。

## 对其他模块开放（api.use('mijia')）

同进程的其他模块可以经 `api.use('mijia')` 拿到结构化接口（不走 QQ 权限门，调用方自担权限）：

```js
const mijia = api.use('mijia')

// 多维筛选设备列表
await mijia.listDevices({ room: '客厅', type: 'light', online: true })
//   -> [{ did, name, model, roomName, isOnline, type, label, controllable }]
//    type: light/switch/ac/curtain/fan/sensor/hub/other；room 为子串匹配

// 按房间汇总（场景/报表模块好用）
await mijia.listRooms() // -> [{ room, total, online, types: { 灯: 2, ... } }]

// 开/关（did 或设备名，模糊匹配唯一命中才执行）
await mijia.control('客厅灯', true) // -> { ok, message }

// 调属性（key 用规格 key 或语义名 brightness/colorTemp/volume）
await mijia.setState('客厅灯', 'brightness', 50)

// 查当前状态（含该型号的规格控件表）
await mijia.getState('客厅灯') // -> { ok, state: {p2_1: true, ...}, controls: [...] }
```

QQ 侧入口仍是三个：`/米家` 命令、私聊自然消息、AI 工具 `mijia_control`
（list 可按 room/type/online 筛选，state 查状态，set 调亮度色温音量等）。

## 说明与风险

- 米家云是**非官方接口**：小米改版可能导致失效，届时需跟进修复。
- 开关指令有最小间隔节流（1.2 秒/台），防误触连点触发风控；设备列表走缓存。
- 从 v1.0.0（密码 + OTP 通道）升级的用户：旧令牌与新通道不通用，升级后需到面板重新扫码一次。
- 二维码约 2 分钟过期，超时面板会自动换新码继续等。

## 许可

MIT。RC4/签名等协议小件按 MIT 独立实现，版权归其原作者。
