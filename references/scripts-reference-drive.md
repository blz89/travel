# 脚本用法速查 · 自驾分支（只在选「自驾」并要避堵路线时读）

> 公共交通 / 流程二任务**不要读本文件**；通用脚本（`12306` / `plan` / `flight` / `make_html` / `gate` 等）见 `references/scripts-reference.md`。

## map-shot.js 用法（**自驾路线出图唯一入口**；完整用法跑 `node scripts/map-shot.js --help`）

```
node scripts/map-shot.js link <points.json> --out urls.txt   # 出高德链接（网页版 + App scheme）
node scripts/map-shot.js shot "<链接>" <目的地>自驾路线截图.png --wait 24000 --scale 2
node scripts/map-shot.js shot "<链接>" <出图.png> --nodes nodes.json --single   # 带标注 + 只留一条路线
node scripts/map-shot.js shot "<链接>" <节点图.png> --pref 不走高速 --single --nodes nodes.json  # 绕行图：地图自己画地面线
node scripts/map-shot.js shot "<链接>" <探针.png> --js probe.js                 # 注入探测（只读页面状态）
node scripts/map-shot.js selfcheck                           # 不联网自检：坐标转换 + 链接拼装
```

- **`link`**：把**起终点（`vias` 默认留空 ＝ 地图默认最快线，只有客户点名要某条走廊时才填 1 个）**拼成 ① 高德**网页版**链接（免 key、`via[i]` 多途经点；**URL 的 `policy` 参数网页版无效**，别指望它换线）② 高德 **App 唤起**链接（Android `amapuri://` / iOS `iosamap://`，`vian` + `vialons/vialats/vianames` 竖线分隔，`sourceApplication` 必填但**不是 key**）。
- **`shot`**：无头 Edge + CDP：导航 → **等地图渲染完**（默认 24s）→ Esc 关登录浮层（必要时 `--click x,y`）→ 截图。**截图是内嵌素材、不是独立交付物**——由讲解页 `data:` 内联成单文件，不单独发 PNG。
- **`shot --nodes <nodes.json>`**：**两种图面模式**（开关写在 JSON 顶层对象）：① **总览图（客户 2026-10-17 定稿）**＝`{ "legend": false, "parallel": true, "marks": [ … ] }`，**图上只有「点 ＋ 水平引线 ＋ 名字」**——拥堵段＝主线上的**红点**＋水平引线引出段名（`labelDir:"w"`）、电车充电＝**蓝点**＋水平引线引出服务区名（`labelDir:"e"`），**不出菜单、不写表、不编号、不用线色涂段**；`parallel:true` 会把同侧标注按 y 排成互不重叠的平行阶梯（引线只走水平）。② **节点图**＝默认（带菜单）：**卡点／充电位＝小圆点＋引线＋名字**，说明进菜单。文件顶层也可以是**裸数组**或 **`{ "legendTitle":"菜单：…", "marks":[ … ] }`**。
  - 线（拥堵段）：`{ "type":"line", "level":"high|mid|low"（或 "color":"#C62828"）, "label":"① 古田枢纽（4 次 · 2026 点名）", "weight":10, "opacity":0.72, "points":[[lng,lat],…] }`（`label` 只进菜单）；**地面绕行线不该由我们画**——用 `--pref 不走高速` 让地图自己画（见下），**只在没法让地图画时才**用 `"dash":true` 的绿虚线兜底。`opacity` 让地图自己的线透出来，一眼能看出哪些是标注。
  - 点：`{ "label":"示例服务区A服务区", "legendLabel":"1 示例服务区A服务区 231 km 国家电网", "lng":…, "lat":…, "color":"#0B72C4", "r":7 }`——**`label`＝地图上引线引出的短名**（客户 2026-10-16：「拉出一条线引导其服务区名字」），**`legendLabel`＝菜单里的长名**；**点默认不画编号**（客户口径「图上不要编号」）：只有显式写 `number:true` 才贴序号圆点，`parallel:true` 的总览图一律不画；`badge` 只对 `type:"line"` 生效（`badge:true` 才在线上画编号圆点）。
  - `sep` 行：`{ "type":"sep", "label":"沿途充电点（非拥堵路段服务区，间隔 221–275 km）" }`——**只在节点图的菜单里当小标题用**；总览图 `legend:false` 时菜单不建、`sep` 也不画，别加。
  - `legendTitle` 支持内嵌 HTML（用 `<div style="font-weight:400;font-size:11px">…</div>` 加一行小字说明，例如"图上绿线＝地图自己按偏好算的路，报告只加红线标注"）。
  - 画完自动加菜单再截图；**摆位顺序＝（**仅节点图**）菜单先摆、标注后摆**（菜单按四角＋两个底边共 6 个候选位择优，标注候选位多：每个点由近到远试 26/52/86/126/172/224 px × 四方向），所有元素都按**压线几何**打分避让，障碍＝**地图真实折线（AMap overlay 采样）＋ 地图控件矩形 ＋ 左侧路线面板 ＋ 已摆元素**；**先要"四不压"（不压路线 / 不压别的标签 / 不压控件 / 不压面板），找不到才退让，但不许飞到半张图外**。**`shot` 结束会打印 `标注压线 / 标注互压 / 标注退让 / 压线分`——交付前四个数必须全是 0。** **总览图加 `{"legend":false,"parallel":true}` 时不画菜单、引线只走水平、同侧按 y 排成互不重叠的阶梯（点用 `labelDir:"w"|"e"` 指定侧）**；**点必须先投影到路线折线上再写进 JSON**，否则会跑到线外（实测锚点离线最多 9.5 km）；**换走廊后要重跑 `link`**（`_u_*.txt` 是缓存，不重跑会把标注投到旧地图上）。分级与布局口径见 `references/driving-route-planning.md` §8。
  - **菜单末行固定带两句声明**（脚本内置，不用自己写）：「底图与图上实线＝地图自己算路绘制；红／蓝点、引线与名字＝本报告加的标注」＋「**底图上金色／彩色小圆点＝高德自带的设施图标（服务区、加油站等），不是本报告的标注**」。**底图 POI 图标画在 map 的 canvas 上（`--js` 探过：命中只有 `CANVAS.amap-layer`），DOM 删不掉、还会压在我们画的绿线上**——客户 2026-10-17 就问过"总览图里为什么有一个黄点"；**只能靠这句声明解释，不要去改图**。 **点用 DOM `AMap.Marker` 渲染**（`content` 放带白边的圆 div）——`AMap.CircleMarker` 在矢量层会被高德地名层压住（实测红点被「丙城」「乙城」文字盖掉）。
- **`shot --single`（交付图必加）**：高德网页版默认把 **2–3 条备选路线一起画出来**（左侧面板也列成多张卡片），交付图会"很混乱"（实测被客户打回）。`--single` 只对 `--pick N` 指定那张卡执行点击、把**其余卡片与备选折线隐藏**（拥堵着色线、底衬不动），**它不点「偏好」**——要「不走高速」另加 `--pref 不走高速`（`--pref` 在 `--single` 之前）；要指定"必须是第 N 张卡片"那条就加 **`--pick N`**（N 从 1 数）。**认线看颜色**：选中＝品牌绿 `#00C86E`、备选＝浅绿 `#9ADEC8`——**别按"点数多"认线**（短程路线点数少会认不出，实测节点图那样就漏清理了）。**⚠ 默认选中/首推哪条会随实时路况变**（实测甲城→乙城交付线几十分钟内就掉出前三张卡片）→ 客户指示「默认地图最快线」：**不钉途经点**，先出图、按图上这条线做分析，**一个交付内所有数字取同一次查路读数**并写明读数时间。**只有客户指定走廊时才钉 1 个**（靠终点一侧；实测 1 个与 2 个折线逐点一致），**别钉 2 个**。
- **`shot --pref <文字>`**：点开页面「偏好」并选里面那一条（例：`--pref 不走高速`）→ **地图自己按地面路算路并画线**，我们不用手绘绕行线；在 `--single` **之前**生效，两项一起用。**URL 参数 `policy=3` 实测无效**（网页版照样给高速），要"不走高速"只能走这一项。偏好面板用完会被自动收起（可能留一个折叠触发器，属正常）。
- **`shot --js <inject.js>`**：页面渲染完后注入一段 JS，返回值打印出来（调页面内部状态、做一次性探测用）。
- **`points.json`**：`from`/`to`（`name` + `lng`/`lat`）、`vias[]`（避堵=**地面走廊途经点**（先用「不走高速」模式找走廊，再按走廊上的点加密）、钉两端=**下道口 + 上道口**；**总览图默认留空**，电车充电点改为图上**小蓝点＋引线**标注）、`coord`（`gcj02` 默认 / `wgs84` 自动转）、`policy`（0 推荐 / 1 避拥堵 / 2 避收费 / 3 不走高速）。
- ⚠ **硬性**：单条链接途经点 **≤10**（超出**按里程分段、每段一条链接**——短途 1 条够、1000 km 以上走廊常见 3～10 条）；**坐标系必须标对**（GCJ-02）；**必须等渲染再截**（load 事件就抓＝白板）；**保留 `© 高德` 版权号、仅供客户本人查看，不得公开再分发或商用**；**里程以图上为准**。
- 前置：**Node ≥ 21**（全局 WebSocket）+ 本机 **Microsoft Edge**；**不需要 key**。完整口径见 `references/driving-route-planning.md` §8。
- `node scripts/drive_emit.js <route.json> --image <路线图.png> [--vehicle 电车|油车] [--date YYYY-MM-DD] [--out data.json]`：**直接产出自驾讲解页 data.json 骨架**——封面四卡、总览、路线图章节（`--image` 必填且文件须存在）、〔电车〕充电清单表头 + 1 行占位、拥堵解读表（含「未发现被点名路段」行）、未获取项与复核清单（含「严重度」分级说明）、来源。写「油车」则整段不出充电清单、且全文不出现「充电」字样（`--check` 会拦）。补完跑 `make_html.js drive --check`。
- ⚠ `shot` 的两个参数都是**位置参数**：`node scripts/map-shot.js shot "<高德链接>" out.png`。**没有 `--out`**（写成 `--out` 会把选项名当文件名，生成一个叫 `--out` 的图片）。

## congestion-nodes.js 用法（**避堵链 ①②③ 的唯一入口**）

```
node scripts/congestion-nodes.js <route.json> [--date 2026-10-01] [--out nodes.json]
                                 [--top 3] [--max-off 15] [--json] [--debug] [--quiet]
node scripts/congestion-nodes.js --selfcheck        # 不联网：自检地名切分 / 聚类 / 排名
```

- **做什么**：① 取**地图最快路线**当主线（记里程 / 耗时 / 折线）→ ② 把结论库里**被点名**的路段按地名定位（**先用"收费站/互通/服务区"这类高速要素**，裸地名放最后），算它离主线折线多远（默认 **≤15 km ＝压线**）→ ③ **给节点排名**（压线 → 命中次数（年+节假日）→ 最新年份 → 施工/隧道群/枢纽/省界 → 主线先后），排名前 N 标 `needDetail`（要出精细化图）。
- **三道自动防错（实测踩过才加的）**：**① 省别校验**——记录自带 `scope`（福建/广西/…），定位到别省直接丢；**② 路由核对**——锚点自带的道路名（如「示例县A收费站(**G25**长深高速出口)」）必须与记录的路名一致，否则判为**平行线**并剔除（实测剔掉了 G70 福银 @230 km、G55 二广 @951 km 两条假节点）。跨段记录（A 至 B）**不取中点**，两个锚点各自投影、取离主线最近的那个；**③ 地名三态**——站点名/出入口名按"精确 / 近似 / 未收录"分别处置，未收录的不得硬匹配。
- **输出**：`nodes[]`（排名 / 线上里程 / 离主线 / 命中次数 / 年份 / 依据 / 锚点）、`parallelExcluded[]`（平行线剔除）、`unmatched[]`（定位失败＝**未获取**）。
- **只排名、不打分**：拿不到分段时长数据；评分制（次数 5 / 中位数 5 / 平均 3 / 最长 2，>8 分必须精细化）等有数据再启用。
- ⚠ **`AMAP_KEY` 只从环境变量读**，脚本**不写 key**；**厂商原始响应不落盘**，输出的是我们自己的结论与来源引用。**前置：Node ≥ 18**。**没有 key 时**：`congestion-nodes.js` 会直接报错——按 `driving-route-planning.md` §5 末尾的降级走（库结论 + 免 key 截图 + 如实标注"未做取线校验"），不要卡住自驾分支。
- **直出出图标注**：加 `--marks marks.json` → 每个节点按 `km` 投影到主线上、名字取路段名、红点按严重度分色（`high` #C62828 / `mid` #F4511E / `low` #FF8A80）、`labelDir:"w"` 水平引线、顶层 `legend:false, parallel:true`，**直接喂** `map-shot.js shot … --nodes marks.json`（不用再手工把 `nodes.json` 转成 marks）。
- **严重度由本脚本判定**：带 `--date <出发日>` 时每个节点都输出 `level`（`high` 深红 / `mid` 红 / `low` 浅红）与 `levelWhy`（判定依据）——**出图直接把这个 `level` 喂给 `map-shot.js --nodes`，不要人工上色**。
- 完整链路（节点绕行设计 / 精细化图 / 证据表交付）见 `references/driving-route-planning.md` §6、§8。
- **讲解页的硬性校验在生成时做**：`make_html.js drive <data.json> <out.html> --check` 会先跑 `lib/validate.js`（依据/预案表、未获取、复核清单、严重度、禁用断言）再出页；`check_html.js` 只查通用 HTML 项（A/B/C），**没有 drive 专用规则、也没有 `--kind` 参数**——不要把 `--kind drive` 写进文档或命令行。

## make_html.js drive 用法（**自驾路线讲解页唯一入口**；完整用法跑 `node scripts/make_html.js --help`）

```
node scripts/make_html.js drive <data.json> <out.html> --check
```

- **必须内嵌 `map-shot.js shot` 出的截图**（`data:` base64，交付仍是一个 HTML 文件；截图本身不单独发）：截图是"图"，这一页是"文"（图怎么来 / 怎么读、途经点清单、为什么走这条走廊、当天会堵的地方 + 下道绕行 / 错峰预案、电桩计划、时间账、口径与来源）。
- **`sections[type=map].image` 填截图文件路径**：生成器自己读文件、转 base64 **内嵌**（交付物仍是零外链单文件；`check_html.js` 只放行 `data:` 内联图，外链图片照样拦）。
- `waypoints` 第一行是表头；`sections[]` 支持 `map / waypoints / table / grid3 / notes / sources` 六种；`coverCards`、`overview.rows` 与其它页同一口径（同样必需）。
- 页面里**不许出现脚本名 / 接口名 / 数据源名**（A7 会拦）；**官方发布单位、年份、节假日要写**（拥堵数据的底线要求）。
