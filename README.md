# travel（旅游出行规划）

> ⚠️ **适用范围：仅中国大陆（内地）。** 港澳台及境外（含国际行程）**不适用**——数据源（12306 铁路、国内机场航线快照、ChinaTravel 10 城景点基线）与全部口径都只覆盖内地，**不要用本技能的流程、字段与页面骨架去套境外行程**。

DSH 技能：**旅游出行规划**。先定出发地与目的地、再选出行方式（公共交通 / 自驾 / 已在目的地）；公共交通给「出发地 → 目的地」的城际交通方案（**只分析铁路与空中**），随后做**目的地景点分析**（5～10 个景点，含开放时间、官方网址、好评/差评与来源标注），客户选完景点后再问一句「是否需要景点路线规划」，选「是」才给逐站站点级的**行程方案**。

- **交付物**：公共交通 / 景点 / 行程 = **单文件 HTML**（零外链零依赖，双击即用浏览器打开）；**自驾避堵另交「地图截图 PNG + 单文件 HTML」两份**（截图即交付物，页面做解读）；两种情况都**不产出 PDF**。
- **硬口径**：三段输出（最省钱 1 + 最快 1 + 额外 ≥2）、价格必标票种、过夜标红、换乘余量门槛、景点数量与热门配比等，**一律以 `SKILL.md` 为准**。

## 目录结构

```
SKILL.md                 技能正文（流程、门禁与硬性口径）
references/              按需加载的参考手册
  phase-1-transport.md     流程一：城际交通方案
  phase-2-spots.md         流程二：景点分析（含步骤 8 路线规划选择框）
  phase-2-itinerary.md     行程方案规则
  driving-itinerary.md       自驾口径（景区之间的行车路线）
  driving-route-planning.md  自驾路线规划（拥堵规避 + 电车充电点；交付＝地图截图 ＋ 讲解页）
  air-fallback.md          空中兜底 / 转机
  no-ticket-fallback.md    无票兜底（买长乘短 / 补票）
  seat-and-window-rules.md 席别与时间窗口规则
  spots-research.md        景点预研分工与子代理 prompt 模板
  scripts-reference.md     脚本用法
scripts/                 可复用脚本
  12306.js  plan.js  flight.js  make_html.js  check_html.js
  itinerary.js  spots_baseline.js  spots_check.js  reply_check.js
  map-shot.js              自驾出图：高德链接 + 无头截图（Node≥21 + Edge）
  congestion-nodes.js      避堵链①②③：最快线 → 沿主线逐段取证 → 拥堵节点排名（证据表 JSON）
  traffic-history.js       历史高频拥堵段结论库聚合器（--match 缓存判定 / --check）
  lib/validate.js  lib/convert_chintravel.py
data/high-congestion/    历史高频拥堵段结论库（逐年官方公开清单统计；只存结论与来源）
data/china-travel/       10 城景点基线数据（CC BY 4.0，见其 README）
```

## 使用

把本目录放进 DSH 技能目录（例如 `~/.dsh/skills/travel/`），或让 DSH 从本仓库加载；技能入口是 `SKILL.md`。

## 版本

**V1.1**（2026-10-17，公开版）—— 在 V1.0 基础上新增「自驾路线规划」分支（避堵路线 + 电车充电点 + 地图截图与讲解页）；本公开版已脱敏：历史经验叙述中的真实行程、地名与服务区数据均已匿名化或改为占位示例，`data/high-congestion/segments.json` 为模板（含 3 条示例记录，非真实数据），真实记录按技能内流程自行积累。

## 说明

- 运行时会自动生成缓存（`.flight_cache/`、`.stations_cache.json`、`.neg_cache.json`、`.make_html_runs.json` 等），已在 `.gitignore` 中排除，首次运行自动下载或自动建立。
- 脚本依赖本机 Node.js 与 Microsoft Edge（用于 HTML 出品校验）。
- 数据底线：不编造班次与价格；**技术型**数据来源（12306 / 航班来源网站 / 接口）只写在聊天回复里、不进网页；**内容型来源例外、必须进网页**——景点页的评语来源、自驾讲解页的官方发布单位与年份。
