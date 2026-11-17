# roost 随 roost-bridge 分发的额外许可（草稿）

> 本文件是对 `vendor/roost/LICENSE`（AGPL-3.0-only）的**补充额外许可**，不替代、不修改 AGPL 主许可证。
> 生效日期：2026-11-17

## 授权声明

本人 `tdcq9594`（GitHub 署名「倦飞之鸟」，`package.json` author）是 `qq-bot-roost`（GitHub：`tdcq9594/qq-bot-roost`）的版权持有人。从该仓库提交记录看，全部提交均使用本人控制的身份（`jfzn` / `倦飞之鸟` / `tdcq9594`）；如仍有遗漏，由版权持有人承担本授权的全部责任。

本人据此授予以下**额外许可**（Additional Permission）：

1. 允许将 `qq-bot-roost` 的**未修改**源码副本随 `dsh-aurabot-qq-mods` 仓库中的 `modules/roost-bridge/vendor/roost/` 目录一起分发，并允许其出现在由该模块仓库脚本生成的模块发布 zip 中。
2. 该额外许可允许上述 roost 源码副本与该仓库的 CC BY-NC-SA 4.0 内容、**模块胶水代码的 MIT 许可**聚合分发；AGPL-3.0-only 的要求仅适用于 roost 本身及其衍生作品，不延伸到模块胶水或仓库其它内容。
3. 用户依本额外许可取得 roost 时，仍享有 AGPL-3.0-only 赋予的全部权利；本额外许可不减少、不限制这些权利。
4. `vendor/roost/` 内随包的 `ws`、`silk-wasm` 等第三方依赖按其各自 LICENSE 处理，不受本额外许可改变。
5. 若有人修改 `vendor/roost/` 内的 roost 源码，本额外许可不再适用于修改后的副本；修改者须自行遵守 AGPL-3.0-only 及上游要求。

## 来源与完整性

本额外许可仅覆盖随包副本，其来源固定为：

- 上游仓库：`https://github.com/tdcq9594/qq-bot-roost`
- 版本：`1.1.5`
- commit：`64382086cb735a56a63cca64700231ba694a4123`（`chore(release): 1.1.5`）
- 文件清单与 sha256：见 `SOURCE.sha256`
- 校验方法：见 `SOURCE.md`

## 签署

`tdcq9594` / 倦飞之鸟  
2026-11-17

---

说明：这是一份许可授权草稿。若你希望 stronger 一些，可以直接把 roost 双许可为 MIT/AGPL；若只是为了让本模块仓能过审，上面这份“分发例外”范围更窄。
