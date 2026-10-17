# 脚本用法速查 · 流程一 / 自驾（按需读）

> **自驾分支专用**：`map-shot.js` / `congestion-nodes.js` / `make_html.js drive` 的用法在 `references/scripts-reference-drive.md`——**非自驾任务不要读那份**（省 3k 字符）。
> **流程二（景点 / 行程 / 景区网址）专用**：`spots_check` / `spot_link` / `spots_urlcheck` / `hours_check` / `dateinfo` / `spots_emit` / `itinerary` 的用法在 `references/scripts-reference-spots.md`——**流程一任务不要读那份**。
> 本文件由 `SKILL.md` 指向。**只在需要调用脚本时读**，不要常驻。
> **完整用法一律跑 `node scripts/<脚本> --help`；不要读脚本源码。**

## 12306.js 用法（**完整用法跑 `node scripts/12306.js --help`；不要读源码**）

```
node scripts/12306.js stations <关键词>                     # 搜车站（中文/拼音/简拼/三字码）
node scripts/12306.js tickets <出发> <到达> [日期] [--brief] [--from/--to HH:MM] [--out <文件>]   # 查全部车次（核心）
node scripts/12306.js transfer <出发> <到达> [日期]          # 官方中转（**只取第一页**）
```

- **`--digest`：5 列摘要**（车次 / 发→到时刻 / 历时 / 最便宜席别票价 / 该席别余票），实测同一线路约为 `--brief` 的一半字符——**只想知道有哪些车、还不需要席别全谱时用它**；要喂 `plan.js` 仍用 `--brief`（它解析 brief 行）。
- **日常只用 `tickets ... --brief`**：每车次一行，含全部席别的票价与余票。`--out <文件>` 落盘就用它自带的选项（**别用 PowerShell 的 `>` 重定向，会变 UTF-16**）。
- **缓存一律不在技能目录里**（`scripts/` 保持干净，不会被复制进安装副本；唯一例外：`data/spots-links.json` 是评审数据集、跟随仓库）：12306 站表与负缓存、航班数据、HTML 重生成计数全部落在 `%TEMP%\travel-cache\`（覆盖位置：`RAIL_CACHE_DIR` / `FLIGHT_CACHE_DIR`）。纯缓存，删了只会重新拉一次，不影响结论。
- **正向 tickets 缓存**：同「出发站 + 到达站 + 日期」在 **2 分钟**内复用上次成功结果（`.tickets_cache.json`，与负缓存同目录、同样不在技能目录里）；命中时 stderr 打 `[缓存] … 命中 N 秒前的查询结果`。回转（改人数、改景点顺序）与前后对比不必重查 12306；余票刚变过就加 `--refresh`，要彻底关掉读写加 `--no-cache`。
- 什么时候**不该**信缓存：客户明确说“刚有人退票 / 刷新看看”、或距上次查询超过 2 分钟 → 加 `--refresh`。
- **负缓存（免得你误判"没有车次"）**：脚本只缓存**确定性空结果**（该方向确实查不到车次），TTL 20 分钟、上限 300 条，落在 `%TEMP%\travel-cache\.neg_cache.json`；**被限流 / 风控拦下的失败不写负缓存**——那种情况重试或换端点，不要据此说"无票/无车"。
- **无直达（或直达无票）时，`transfer` 是发现中转的首选路径，先跑它**；但它**只取第一页、给得很少**，返回 0 条或只有 1 条**都不代表**没有别的中转——**必须自己枚举沿途枢纽逐腿拼**。**枚举这件事用一条命令做完，不要逐条打字指挥**：
  ```
  node scripts/plan.js explore --chain "出发站,枢纽1,枢纽2,…,目的地站" [--chain "另一条链"] \
    --date <日期> [--pax N] [--kids N] [--from HH:MM --to HH:MM] [--arrive-by <到达日>] \
    --route "<起点>→<终点>" --out-dir <目录> --emit-data <目录>/data.json
  ```
  **你只给"哪几个枢纽值得试"（这是判断，仍归你）；逐腿查询 → 拼链 → 合并去重 → 换乘校验 → 三段归位 → 写出 `data.json` 全部由代码完成。**
  - **为什么必须用它**：一条链要跑 6～8 次调用（每条腿一次 `tickets`、再加 compose / candidates / rank / emit-data），**从前这些都得你逐条打字指挥**——实测一次运行 80+ 次调用，大头就是这个。现在**一次调用拿到短名单**。
  - **`--emit-data` 是关键**：它把 `make_html` 要的 `data.json` **由代码写出来**（价格、总耗时、到达时刻、逐段 `steps`、`costRows`、总览表全是代码算的）。**你只需补 `coverNote` 与各处 `footnotes` 的文案，不要改任何数字**，然后直接 `make_html.js plan <data.json> <out.html> --check`。
- `make_html.js` 四种页面都会自动在最前面生成「一页速览」节（标题 + 人数 + 封面卡 + 总览表前 4 行，附可复制的纯文本块）。这一段由封面/总览字段自动拼出，**不要自己另写摘要**，也不要删节；窄屏下封面三卡自动隐藏。它在左侧目录里是第一项（`#quick`），客户点目录即可跳回。
- **重生成计数是软的、但有刹车**：同一 out.html 30 分钟内前 2 次正常，第 3–5 次只打 `[WARN]` 照常生成，**第 6 次起 `[REFUSE]` 并 exit 1**（提示 `--reset-runs`）；计数文件在 `%TEMP%\travel-cache\make_html_runs.json`（不写技能目录），`--reset-runs <out.html>` 可手动清零。实测：1–5 次 exit 0（3 次起带 WARN），第 6 次 ⛔，复位后立刻恢复。
    **为什么**：手写十几 KB 的 `data.json` 曾是"两份成品把总价写错"的直接原因（席别改了、明细改了，总价却留着旧值）。**它不额外增加往返**——就在 rank 这一次调用里完成。
  - **枚举枢纽的纪律不变**：走廊上挑 **2～4 个顺路大节点**（如宁德→西安取杭州东、郑州东；南昌→丽江取长沙南、贵阳北、昆明南），**只挑顺路的**；候选上限见下条。
  - **`explore` 失败会如实点名是哪条链、哪条腿失败**并提示换枢纽或换日期——**不得据此判"不可达"**。
  - **`plan.js compose`（跨腿拼链）**：若你要手工控制腿文件（如含跨市地铁/城际/大巴等非铁路腿），按 brief 格式手写腿文件后跑 `compose 腿1.txt 腿2.txt …`。完整格式跑 `node scripts/plan.js --help`。
  - **手写 `options.json` 的最小模板（照抄改数即可，别自己发明结构）**——实测"候选装配 4 轮返工"全部出自下面这四条：
    ```json
    [
      {
        "name": "高铁 G1523 直达（二等座）",
        "kind": "铁路",
        "windowHit": "窗口外",
        "extraCost": 0,
        "legs": [
          { "code": "地铁2号线", "from": "家", "dep": "2026-10-01 07:10", "to": "上海虹桥", "arr": "2026-10-01 07:48", "cost": 5, "seat": "地铁" },
          { "code": "G1523", "from": "上海虹桥", "dep": "2026-10-01 16:00", "to": "武汉", "arr": "2026-10-01 22:55", "cost": 615.5, "seat": "二等座" }
        ]
      }
    ]
    ```
    **四条硬规则（照做就不会返工）**：
    1. **腿按时间先后排**：接驳腿在最前、被接驳的车次腿在后。**顺序错 → 报"时刻倒挂"**。
       **站名与时刻一律从 `--brief` 或 `explore` 写出的 `candidates.json` 里照抄**——实测凭印象写站名（把"上海站→南京"写成"上海虹桥→南京南"）直接导致一轮返工。
    2. **每条腿都要 `seat`**（票种）：铁路写 `二等座`/`硬座`/`硬卧`，航空写 `经济舱`，接驳写 `地铁`/`打车`。缺了 → `--emit-data` 给不出票种、被生成器的**「价格必须标明票种」**校验拒。
    3. **跨天必须把日期写全**（`"YYYY-MM-DD HH:MM"`）：只写 `HH:MM` 推不出到达日，`rank --arrive-by` 会拒收。
    4. **异站衔接写 `transferMin`**（= 从上一段到站到本段发车所需的接驳分钟数，含出站/转场/进站）：**规范写法是写在后一段上**；写在前一段现在也能认，但**别两处都写**。
       **更稳的做法是直接补一段接驳腿**（既给耗时又给费用，还能显示在页面上）。
    **⚠ 落盘 JSON 一律用 `write` 工具**，不要用 PowerShell here-string / `Set-Content` 写 JSON——那会带上 **UTF-8 BOM**（实测因此多花一次"编码修复"往返；`12306.js` / `plan.js` / `make_html.js` / `itinerary.js` 现在都容忍 BOM，但没必要制造这个问题）。
  - **候选上限 4 个**：每次查询都可能触发 12306 限流（见「数据源 → 12306 限流提示」），**不要为凑候选无限查**。
- **跨天到达标记 `(+1天)`**：脚本按"**到达时刻不晚于发车时刻**"判定 = **车上过夜**。**这是确定性依据**——「普速席别顺序」与「过夜一律标红」都以它为准，不要靠肉眼比对钟点去猜。
- 出发/到达可写**城市名**（自动选主站）或**具体站名**；大都市多站**窗口内无票/无车时再查同城其他站**，方案里说明从哪个站走。

## plan.js 用法（**唯一的方案裁决入口**；完整用法跑 `--help`）

```
node scripts/plan.js <brief.txt> [--at HH:MM | --from HH:MM --to HH:MM] [--pax N] [--kids N] [--json]   # 筛选（= screen，默认模式）
node scripts/plan.js rank <candidates.json>                                                   # 三段归位（--json 仅 screen 模式生效）
node scripts/plan.js candidates <options.json> [--out candidates.json]                         # 装配候选（输入是你按「段」写好的方案清单，**不是 brief 文本**；形状见 --help）
node scripts/plan.js explore --chain "起点,枢纽…,终点" --date 2026-10-01 […]                                                  # 探索（更宽窗口）
node scripts/plan.js compose <腿1.txt> <腿2.txt> […]                                            # 组方案（含分段拼接）
```

- **默认模式**就是**筛选（`screen`）**；正文里出现的 `candidates` / `explore` / `compose` 也都是本脚本的子命令（`--help` 为准）。
- **筛选模式**：把 `--brief` 全谱交给它，**只看它给的短名单**——不要让模型逐条套窗口 / 余票 / 席别规则。
- **归位模式（`rank`）**：三段归位也交给它算（见「方案生成 → 三段归位」），**不要在文字里排**。
- **退出码**：`0` = 窗口内有可用；`2` = 窗口内无可用（**仍会打印窗口外候选**，可作"窗口外最近班次"用）；`1` = 用法或解析错误。
- **口径同源**：本文件「时间窗口规则 / 人数与余票规则 / 席别规则 / 无座票规则」= 脚本的实现依据；**两者冲突时以脚本为准，并把冲突回报给用户**。

## flight.js 用法（**先判成立条件**；完整用法跑 `node scripts/flight.js --help`）

```
node scripts/flight.js route <出发> <到达>      # 有无直飞、承运航司（含中文名）
node scripts/flight.js airport <关键词>         # 查机场
node scripts/flight.js cities                   # 内置中文城市 → 机场对照
```

- **数据边界（必须遵守）**：该库是**社区历史快照**，**不含班期 / 时刻 / 票价 / 余票**，也**不代表该航线目前仍在执飞**。
  - ✅ 只用于**初步判断"该方向有没有直飞"**、避免凭空编造；
  - ❌ **严禁**据它宣称"有航班 / 可以坐飞机过去"——是否仍在执飞、班期与价格**必须用 `web_search` 实时确认**；
  - 实时结果与它冲突 → **以实时结果为准**，按 `references/air-fallback.md` 如实说明。
- 目的地**无机场**（如东莞）会报"无法识别机场"→ 改用**最近机场**（如广州白云/深圳宝安）并在方案里写明**落地机场**；**落地后的市内/城际接驳不在方案内**（一句提示）。
- ⚠ **本库对中国机场覆盖不全——覆盖判据、两种"覆盖不可用"的样子、补救办法与"真结论"反例，一律见 `references/air-fallback.md`「空中数据降级规则」第 1 条（本技能头号红线，只在该处定义，此处不复述）**：命中覆盖不可用（**机场表未收录** / **机场表有但航线表零记录**）时，**不得据此判"无直飞"或"不可达"**，改用 `web_search` 查该方向实时航班（**含中转**）或用机场官网时刻表核对。
- **三字码不再因"库未收录"而报"无法识别机场"**：脚本一律接受三字码；若该地**确实没有机场**，才走上一行"改用最近机场"。
- 数据首次运行自动下载，缓存 30 天（`%TEMP%\travel-cache\flight`；可用 `FLIGHT_CACHE_DIR` 覆盖）。

## 其余脚本（同一目录，按需调用）

```
node scripts/traffic-history.js data/high-congestion/segments.json --check     # 结论库体检（字段/年份/来源/窗口）
node scripts/traffic-history.js data/high-congestion/segments.json --match "G80,G72" --corridor --top 5   # --match 必须带取值
node scripts/traffic-history.js --selfcheck                                   # 解析器自检（不需要数据文件）
node scripts/gate.js <plan|spots|itin|drive> <data.json> <out.html> [--reply <回复.txt>]   # 三道门禁一次跑完（推荐）
node scripts/reply_check.js <回复.txt>                                         # 回复稿门禁（R1≤20 行 / R2 内部用语 / R3 不复述页面）
node scripts/check_html.js <out.html> [--spots]                                # 成品门禁（gate 已包含；单独查版式时用）
```

- **`gate.js`**：**交付前跑这一条就够了**——按顺序「数据门禁 → `make_html … --check` → `reply_check`」，末行固定 `GATE_SUMMARY kind=… data=… html=… reply=… exit=0`；前一步 FAIL 就停。**别再把三个脚本手动拼三轮**（实测最容易漏掉 reply_check）。
- **`traffic-history.js`**：`--check` 退出码分级（0 合格 / 1 用法错 / 2 数据不合格）；`--match` 按走廊高速编号筛命中，输出「命中明细（年·节假日）」。
- **`reply_check.js`**：**发给客户前必须跑**，3 PASS 才能发（脚本名 / 内部用语出现在客户可见文本里会 FAIL）。
- **`station_far.js --check "南宁西,南宁东"`**：同城多站时判断车站离市中心是否太远。`FAR`（≥15 km，名单见 `data/stations-far.json`）→ 有近站方案就换、只能用它时写明接驳代价；`MAIN` 主站 / `NEAR` 边缘站 → 可用；`UNKNOWN` 未收录且带「西/南」→ 需要时查一次 `web_search`。机场不做此判断。
- **`alias.js resolve --name "Guangzhou South"`**：英文 / 拼音地名 → 中文归一化。`resolved` 直接用；`ambiguous`（suzhou = 苏州/宿州、fuzhou = 福州/抚州、taizhou = 台州/泰州、yichun = 宜春/伊春）让客户确认一次；`chinese` 不处理；`unknown` 请客户写中文或查一次。带方位（south/north/east/west、nan/bei/dong/xi）自动拼站名，如「Guangzhou South」→ 广州南。

## 流程二的脚本

> 景点页 / 行程页 / 景区网址相关脚本（`spots_check` / `spot_link` / `spots_urlcheck` / `hours_check` / `dateinfo` / `spots_emit` / `itinerary` / `spots_baseline` / `narrow`）见 **`references/scripts-reference-spots.md`**——**流程一任务不要读那份**。

## flow.js 用法（提问框的唯一真源）

- `node scripts/flow.js next --state <state> [--json]`：**提问框的唯一真源**（13 状态：`origin / dest / mode / plan_source / date / time / pax / spots_pick / drive_ask / drive_when / drive_car / drive_range / has_transport`）。输出可直接喂 `ask_user_question` 的 `{header, question, options?, multiSelect}`；末行 `FLOW state=… next=…`。`--list` 列全部 13 个状态、`--check` 自检（一框一问、选项 ≥2、next 指向存在）。改问法只改这里。
