# travel（旅游出行规划）

> ⚠️ **适用范围：仅中国大陆（内地）。** 港澳台及境外（含国际行程）**不适用**——数据源（12306 铁路、国内机场航线快照、ChinaTravel 10 城景点基线）与全部口径都只覆盖内地，**不要用本技能的流程、字段与页面骨架去套境外行程**。

DSH 技能：**旅游出行规划**。先定出发地与目的地、再选出行方式（公共交通 / 自驾 / 已在目的地）；公共交通给「出发地 → 目的地」的城际交通方案（**只分析铁路与空中**），随后做**目的地景点分析**（5～10 个景点，含开放时间、景区介绍网址、好评/差评与来源标注），客户选完景点后再问一句「是否需要景点路线规划」，选「是」才给逐站站点级的**行程方案**。

- **交付物**：公共交通 / 景点 / 行程 / 自驾 = **单文件 HTML**（零外链零依赖，双击即用浏览器打开；地图截图是**内嵌 base64 素材**，不单独发 PNG）；**不产出 PDF**。
- **缓存与状态文件**：**会话状态与缓存**全部落 `%TEMP%\travel-cache\`，不写技能目录（可用 `RAIL_CACHE_DIR` / `FLIGHT_CACHE_DIR` 覆盖）；**唯一例外**是 `data/spots-links.json`（景区介绍网址的评审数据集，跟随仓库、跨机器复用，不是会话状态）。
- **口径唯一来源**：`SKILL.md` 正文 + 各脚本 `--help`。本文件只说明目录与数据来源，不重复流程。

## 目录结构

```
SKILL.md                       主文档：流程、口径、门禁、输出纪律（唯一真源）
README.md                      本文件
data/
  city-alias.json              英文/拼音地名 → 中文（134 个写法，含 4 个歧义词）
  stations-far.json            同城偏远车站表（8 站，>15 km 提醒换站）
  holidays-cn.json             法定节假日（2025/2026 已发布；2027 未发布→certainty=low）
  spots-links.json             景区介绍网址的评审缓存（spot_link.js 写，spots_check B8 核对）
  high-congestion/segments.json 历史高频拥堵段结论库（traffic-history.js / congestion-nodes.js 读）
  china-travel/                ChinaTravel 景点基线（CC BY 4.0，10 城；attractions.json.gz，spots_baseline.js 解压读）
references/                    按需读，读完一份再读下一份
  phase-1-transport.md         流程一：城际交通方案 → HTML
  phase-2-spots.md             流程二：目的地景点分析 → HTML
  phase-2-itinerary.md         流程二续：逐站行程 → HTML
  seat-and-window-rules.md     席别 / 时间窗口 / 换乘门槛的完整口径
  air-fallback.md              空中方案的成立条件、票价与取数降级
  air-transfer-rules.md        转机组合规则（无直飞时才读）
  no-ticket-fallback.md        买长乘短 / 补票（兜底，用到才读）
  driving-route-planning.md    自驾路线规划口径（选「是」时读）
  driving-pitfalls.md          自驾 35 条实测踩坑（出问题时查）
  driving-itinerary.md         景区间行车路线（自驾行程用）
  scripts-reference.md         流程一脚本用法（12306 / plan / flight / gate / traffic-history）
  scripts-reference-spots.md   流程二脚本用法（spots_check / spot_link / spots_emit / itinerary / hours_check）
  shift-discipline.md          下移纪律（改脚本/判据前读：真源唯一、门禁阻断、输出摘要、状态外置）
  scripts-reference-drive.md   自驾三件套（map-shot / congestion-nodes / make_html drive）
  spots-research.md            景点预研的分工纪律与派发方式
  spots-prompt-template.md     给子代理的自包含任务书（让它自己读，不要抄进 prompt）
scripts/                       纯 Node、零依赖（Node ≥ 21；本机 Edge 仅自驾出图用）
  12306.js         车次/余票/票价/中转/站表（正向缓存 2 分钟 + 负缓存 20 分钟）
  flight.js        历史航线库（只判"有没有直飞"；班期与票价走 web_search）
  plan.js          方案裁决唯一入口：compose / candidates / rank / screen / explore
  itinerary.js              两两距离矩阵 / 串线 / 生成行程页骨架（emit）
  spots_peak.js             行程页两套方案（最快 / 避峰）
  make_html.js     HTML 生成唯一入口（plan / spots / itin / drive）
  gate.js          一条命令跑完数据→成品→回复三道门禁
  check_html.js    成品门禁 A/B/C（结构 / 自包含 / 三档宽度真量测）
  reply_check.js   聊天回复门禁 R1–R3
  spots_check.js   景点数据门禁 B1–B8（含网址评审 B8）
  spot_link.js     景区介绍网址评审 / 缓存 / 批量刷新
  spots_urlcheck.js 网址可达性与反爬判定
  spots_baseline.js 景点基线查询（10 城）
  hours_check.js   闭馆核查（到达时刻 → 可游 / 改日 / 剔除）
  dateinfo.js      日期属性 CLI（判定逻辑在 lib/holiday.js，与 hours_check.js 共用）
  flow.js          13 个提问框的唯一真源
  alias.js         地名归一化（英文/拼音 → 中文；歧义让客户点选一次）
  station_far.js   同城偏远车站判定
  traffic-history.js 拥堵结论库聚合器（HIT / MISS）
  congestion-nodes.js 拥堵节点排名 / 绕行设计
  spots_emit.js    景点页 data.json 骨架（自动填封面卡 / 总览 / 网址三轨）
  drive_emit.js    自驾讲解页 data.json 骨架（含证据表头与"未获取"行）
  map-shot.js      高德地图截图（自驾出图唯一入口）
  lib/holiday.js   节假日判定的唯一实现（dateinfo / hours_check 共用）
  lib/validate.js  数据 schema 与网址形状闸门（生成器与 spots_check 同源）
  lib/narrow.js    CDP 窄屏真量测（check_html 的 375px 档）
  lib/convert_chintravel.py 一次性转换脚本：parquet → attractions.json.gz（维护用，不参与运行）
```

## 运行时文件（会话状态与缓存，均在 `%TEMP%\travel-cache\`；`data/spots-links.json` 是数据集例外）

| 文件 | 作用 | 有效期 |
|---|---|---|
| `%TEMP%\travel-cache\.stations_cache.json` | 站名表 | 7 天 |
| `.tickets_cache.json` | 正向余票缓存（同 OD 同日期） | 2 分钟 |
| `.neg_cache.json` | 负缓存，只存"确定性空结果" | 20 分钟 / 300 条 |
| `make_html_runs.json` | 同一 HTML 重生成计数（前 2 次正常；第 3–5 次只 WARN；**第 6 次 REFUSE**，用 `--reset-runs` 复位） | 30 分钟 |
| `flight/` | 航线库快照 | 30 天 |

## 数据来源与许可

- 铁路：12306 官网接口（车次 / 余票 / 票价 / 中转）
- 航线：`jpatokal/openflights` 社区快照（历史数据，不含班期与票价）；实时班期与票价一律 `web_search`
- 拥堵库：本项目实测整理，每条记录带年份与发布单位
- 景点基线：LAMDA-NeSy/ChinaTravel-Sandbox，License **CC BY 4.0**（署名见 `data/china-travel/README.md`）
- 节假日：国务院办公厅年度放假安排通知（`data/holidays-cn.json` 内注明文号与来源）

## 可选环境变量

| 变量 | 作用 | 不给时 |
|---|---|---|
| `AMAP_KEY` | 高德 Web 服务 key：`congestion-nodes.js` 取线、把拥堵节点投到主线上 | 降级：只用拥堵库结论 + 免 key 截图，并如实标注"未做取线校验" |
| `RAIL_CACHE_DIR` / `FLIGHT_CACHE_DIR` | 改缓存目录 | 默认 `%TEMP%\travel-cache` |
| `CHINATRAVEL` | 景点基线可用性（`spots_baseline.js` 自动判） | 未命中即退回 web_search |

## 校验

交付前一律过门禁（不要自己拼判断）：

```
node scripts/gate.js <plan|spots|itin|drive> <data.json> <out.html> [--reply 回复.txt]
```

末行 `GATE_SUMMARY … exit=0` 才算可交付。各脚本 `--help` 是最准的用法说明——**不要读脚本源码**。
