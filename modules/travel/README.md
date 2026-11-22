# 真实世界（travel）

把「行程 / 定位 / 出门 / 票务 / 天时」合成一个模块：一套面板六页、一套规则、一个数据目录。
合并自 travel-hub、trip-loc、outings 三个模块；位置卡统一走 `travel_where`（本模块不含 `loc_send`，原因见「已知限制」）。

## 一、它做什么

- **行程**：查 12306 车次、排直达/换乘、定席别与票价、按时刻表推算「现在到哪了 / 还有多久」。
- **票务**：出纪念票 PNG（票号、车厢座位、票价、二维码全部按规则打码），同一趟只出一张，重复要就给原来那张。
- **定位**：有行程按线路推算并发位置卡；没行程发最后点位卡。地名、门牌、坐标纠偏走高德，备用高德与天地图。
- **出门**：本地点位、看海/爬山/旅游、天气与日落；多日行程受「最多住几晚」「每天远门上限」限制。
- **手上的事**：`travel_stay` 记录「在做什么、还要多久」，到点提醒；模块每轮注入硬规则——手上有事要回话，先暂停再回。
- 工具共 21 个（`travel_*` 12 个 + `out_*` 9 个），命令 6 个。

## 二、运行要求

| 依赖 | 要求 |
|---|---|
| Aurabot QQ 插件 | ≥ 1.2.0（`minPluginVersion`） |
| Python | 3.10 及以上，**需自行安装**；市场版不捆绑运行时 |
| Python 包 | `requests`、`Pillow` |

```bash
python -m pip install requests pillow
```

装好后确认 `python --version` 能跑。模块默认从 PATH 找 `python`（macOS/Linux 找 `python3`）；不想用 PATH 里的，就在面板第 ④ 页「Python 路径」填绝对路径（如 `C:\Python312\python.exe`）。

> 离线分发包（`travel-2.0.2-分发包.zip`）自带 Windows x64 便携运行时，那个版本不需要装 Python；市场版只发源码。

## 三、安装

市场安装即可，落位在 `<插件根>/modules/travel/`。也可以手动把本目录拷进去，重启插件或等热重载。

目录结构：

```
modules/travel/
├─ index.mjs              入口：命名空间代理、规则、每轮硬提醒、清理路由
├─ module.json
├─ panel.js               六页面板
├─ README.md  LICENSE
├─ lib/
│  ├─ hub.mjs             总控与 12 个 travel_* 工具
│  ├─ trip.mjs            引擎与票务（调用 Python）
│  ├─ outings.mjs         出门与 9 个 out_* 工具
│  ├─ clean.mjs           重复插件扫描/清理
│  └─ real/index.mjs      定位 Key 读写占位
├─ assets/engine/         Python 引擎与票面脚本
│  ├─ tripgeo.py  rail.py  rail_plan.py
│  ├─ ticket_png.py  boarding_png.py
│  └─ .stations.json      车站表
└─ docs/config.example.json
```

## 四、配置与 Key

设置键都在 `config.ext.travel`（共 17 个）：`enabled`、`hub_showOutings`、`hub_panelWrite`、
`trip_pythonPath`、`trip_enginePath`、`trip_personName`、`trip_flightProvider`、`trip_flightKey`、`trip_stayNotify`、
`real_enabled`、`real_amapKey`、`real_amapKeyBackup`、`real_tdtTk`、
`out_enabled`、`out_farLimitPerDay`、`out_tripMaxDays`、`out_allowAutoTrip`、`out_locSource`。

Key 只在**面板第 ③ 页**（高德主/备、天地图）和**第 ④ 页**（航班源 Key）填，保存后写进上面三个 `real_*` 键与 `trip_flightKey`。仓库源码里没有任何 Key，也不带任何人的 `config.json`。

默认值：`trip_pythonPath=''`（自动找 PATH）、`trip_enginePath=''`（用 `assets/engine/tripgeo.py`）、`trip_personName='乘客'`、`real_enabled=false`、`out_enabled=true`。示例见 `docs/config.example.json`。

## 五、没填 Key / 没有数据时

| 能力 | 无 Key | 无历史数据 |
|---|---|---|
| 载入、面板六页、规则、硬提醒 | ✔ | ✔ |
| 高铁排程（12306，含经停、席别、真实票价） | ✔ | ✔ |
| 出票、票面 PNG、票号、重复出票拦截 | ✔ | ✔ |
| 出门（本地点位、看海/爬山/旅游）、天气、日落 | ✔ | ✔ |
| 看位置 / 到哪了 / 还有多久 | ✔ | ✔（显示「没有行程，在家」） |
| 地名 / 门牌 / 任意坐标解析、选址纠偏 | ✘ 报「没有高德 key」 | — |
| 飞机段 | ✘ 航班源与 Key 都空着 | — |

出票时票面先画到 `modules-data/travel/tmp/ticket-out`，再拷进数据目录；目录不可写时票号和信息仍然真实，只会照实报「图没画出来」。

## 六、会访问什么、写到哪

- **网络**：12306 公开查询接口、高德 Web 服务、天地图、天气接口；只在用户触发查询时请求。
- **本机文件**：只读写 `<插件根>/modules-data/travel/{hub,trip,outings,real-loc}/`，以及清理时移动 `modules/` 下的异常文件夹（需用户点按钮）。
- **启动的程序**：用 Python 跑 `assets/engine/*.py`，参数走 stdin，不执行用户输入的命令。
- **设置**：通过 `api.settings` 读写 `ext.travel`，Key 也存这里。
- **插件内部对象**：`api.core.modules`（列模块、停模块）、`api.route`、`api.every` 等；插件升级后这些接口可能变。

对应 `capabilities`：`network`、`filesystem`、`process`、`plugin-internals`。

## 七、重复插件：首次只扫描，点按钮才清

宿主的模块按钮 = `modules/` 里的文件夹 + 「文件夹已删但模块还在跑」的那些。所以光删文件夹不够，残留的还要 `stop` 才会从面板消失。

- **首次安装后约 12 秒**：只跑一次 `scan`，把「要归档几个、要停几个」写进 `modules-data/travel/cleanup/auto-scan.json`，**不动任何文件夹、不 stop 任何模块**。
- **面板第 ⑥ 页**：`扫一遍` 只看计划；`清理并归档` 才真执行（`POST /clean/run`）。
- 清理范围：没入口文件的、文件夹名 ≠ `module.json.id` 的、多个文件夹声明同一 id 的、文件夹没了但还在跑的。
- 不碰：内置模块、正常的 canonical 文件夹、`modules-data`、`config` 里的 Key 与设置。
- 全部**移动不硬删**：归档到 `<插件根>/modules-removed/auto-clean-<时间戳>/`，要恢复挪回来即可。

## 八、已知限制

- **不含 `loc_send`**：定位卡原模块的授权文件与源码署名/坐标绑定，不能随开源包分发；位置卡统一用 `travel_where`。
- **票是纪念票**：不具乘车效力，不能凭它上车、改签、报销；票价只取 12306 实时价，取不到就不出票。
- **飞机不可用**：没有真实航班时刻源时不排飞机、不编航班号；只支持国内。
- **12306 频控**：10 分钟约 30 次真实请求，超了会报「过几分钟再排」。
- **Python 需自备**：市场版不带运行时；没装 Python 或缺 `requests`/`Pillow` 时，排程与出票会明确报「引擎没跑起来」。

## 九、许可

MIT，见 `LICENSE`。
