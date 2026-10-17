# 脚本用法速查 · 流程二专用（景点页 / 行程页 / 景区网址）

> 只做**景点 / 行程 / 景区网址**相关任务时读本文件；**流程一的脚本（12306 / plan / flight / gate）在 `references/scripts-reference.md`**，不要为流程二去读那份（省 ~7k 字符）。
> **完整用法一律跑 `node scripts/<脚本> --help`；不要读脚本源码。**

## 景点页 / 行程页脚本

```
node scripts/spots_check.js <景点数据.json>                                    # 景点页数据校验（B1–B8，含网址评审）
```

- `node scripts/spots_emit.js <selected.json> [--out 景点数据.json] [--title "<标题>"] [--note "<本次假设>"]`：**直接产出景点页 data.json 骨架**——输入只要 `[{name, meta, ticket?}]`，脚本自动算封面卡（推荐/热门/不热门/门票统计）、总览表与 `colWidths`，并按 `data/spots-links.json` 的评审结果填 `url`/`urlLabel`（A/B→介绍页；F 或无记录→`urlFallback` 降级文案 + 提醒先跑 `spot_link.js resolve --cache`）。`good/bad/mine/source` 留占位，补完跑 `make_html.js spots --check` 与 `spots_check.js`（B1–B9）。

- `node scripts/itinerary.js emit <plan.json> [--start <名称>] [--out data.json] [--mode bus|taxi|mixed]`：**直接产出行程页 data.json 骨架**——按最近邻串线，封面卡 / 总览表（距上一站已算好）/ `legs` 全部填好，只留「方式 / 耗时」两列"待填"给你补文案。先 `emit` 再补，比从空 JSON 手写省一整轮；补完照样过 `make_html.js itin --check`。

- `spot_link.js resolve` 的末行带 `source="官网|文旅局/管委会|官方名录|媒体专题|网络转载"`（域名五档 `gov/assoc/media/site/aggregator`，只做同分裁决与来源标注，不直接决定合格）。**形状闸门的「频道/栏目首页」「政府日期稿件页」两条会让位给评审**：评审判 A/B 且 `intro` 与该 url 一致 → 放行；判 weak/F 或无评审 → 照旧拦（实现：`lib/validate.js` 的 `REVIEW_EXEMPT` + `reviewGrade()`，按 `spots-links.json` 的 mtime 失效）。
- `node scripts/spots_peak.js <spots-peak.json> [--arrive 09:00] [--start <起点>] [--holiday] [--speed 24] [--max-detour 20] [--json] [--emit-plan <itin-data.json> --out <data.json>]` —— **行程页"两套方案"的唯一入口**：A 最快（最近邻）与 B 避峰（热门景点优先排进「开园后 120 分钟 / 闭园前 150 分钟」两个低峰窗，多起点贪心，代价＝里程+0.15×错过分钟+热门错位）。末行 `PEAK fastest_km=… peak_km=… detour=…% fallback=yes|no`；`fallback=yes` 时默认只交付最快方案。**不读客流数据**，只按开闭园时间推断。
- `node scripts/spot_link.js refresh [--max-age-days 90] [--all] [--dry-run]`：**批量重跑过期条目**（`data/spots-links.json` 里 `checkedAt` 超 90 天的，或 `--all` 全量）。子进程复用 `resolve --cache`，口径不变；`--dry-run` 先看要跑哪些。到期不刷新，`spots_check` 的 B8 会直接 FAIL；**距到期不足 15 天时 B8 只打 `WARN`（不阻断）**，看到 `WARN B8 … 还有 N 天到期` 就顺手跑一次本命令续期。

- `node scripts/lib/narrow.js <out.html> [--width 375]`：底层是 CDP 的 `Emulation.setDeviceMetricsOverride`，真量「375px 视口有没有元素超出」——`check_html.js` 的 C2 就是调它（本机无头窗口最小约 489px，`--window-size=375` 量不准）。一般不用手跑。

```
node scripts/spots_baseline.js <城市> [--limit N] [--search 关键词] [--json]   # ChinaTravel 基线：该城景点清单
```

## 闭馆 / 日期 / 网址可达性

- `node scripts/hours_check.js <景点数据.json> --arrive 2026-10-19T17:40 [--days 2] [--buffer 60] [--holiday] [--json]`：游玩期内闭馆 / 闭园 / 入场时间核查。结论 `open` / `tight` / `shift` / `closed` / `unknown`；`closed` 必剔除补备选，`shift` 按「可游日」排。识别 meta 里的「周一闭馆 / 法定节假日除外 / 11月-次年3月闭园 / 16:00停止入馆 / 全天」，只写 `以景区公示为准` 的判 `unknown`。自驾用出发时刻 + `--buffer 180`。 节假日**默认自动判**（逐日问 `lib/holiday.js`，与 `dateinfo.js` 同一实现）：meta 标「法定节假日除外」的闭馆日按开放处理，并提示节假日开放时间可能调整；`--holiday` / `--no-holiday` 只在判不准时手动覆盖。

- `node scripts/dateinfo.js <YYYY-MM-DD> [--window 1] [--json]`（也有 `--range <起> <止>` / `--list <年>`）：**节假日判定的唯一入口，别自己数日子**。`holiday=yes`＝当天放假；`window=yes`＝法定节假日及前后各 1 天；`adjustWorkday=yes`＝调休上班日（按工作日看）；`certainty=low`＝该年放假安排未发布，只能当"不确定"，要精确避堵先 `web_search` 核官方通知。自驾避堵闸门与 `hours_check.js` 的自动判定共用 `scripts/lib/holiday.js`，数据在 `data/holidays-cn.json`。

## spots_urlcheck.js 用法（景点网址可达性与反爬判定的唯一入口）

- `node scripts/spots_urlcheck.js check <url>… [--json] [--timeout 12000]`（或 `--file urls.json`）：**网址可达性 + 反爬判定**，只读前 4 KB 正文、不进上下文。判定 `ok / redirect / blocked / dead / thin / error`（403/412/429＝blocked；「百度安全验证 / 携程验证 / WAF 环境检测 / Cloudflare 挑战」＝blocked；汉字 < 60＝thin 疑似 JS 渲染空壳）；末行 `URLCHECK ok=<n> bad=<m>`，exit 0/1/2。景点预研先把 web_search 的候选过一遍，再交 `spot_link.js` 评审，能省 5–8 次 `web_fetch`。
