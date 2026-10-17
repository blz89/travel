# ChinaTravel 景点基线数据（静态，CC BY 4.0）

本目录是**景点基线**的离线数据，供 `scripts/spots_baseline.js` 查询，用于免去「每个景点查一次开放时间」的重复检索。

## 来源与许可（**CC BY 4.0，需署名**）

| | |
|---|---|
| 数据集 | `LAMDA-NeSy/ChinaTravel-Sandbox` |
| 许可 | **CC BY 4.0**（可缓存 / 可商用 / 可再分发，**需署名**） |
| 代码仓 | <https://github.com/LAMDASZ-ML/ChinaTravel> |
| 论文 | arXiv:2412.13682（ICLR'26） |
| 团队 | 南京大学 LAMDA-NeSy |
| 取值来源 | HuggingFace 镜像 `hf-mirror.com`（`huggingface.co` 被 DNS 阻断）；ModelScope `Cbphcr/ChinaTravel-Sandbox` |
| 上游更新 | HF `lastModified 2026-09-15`，仍在维护 |

**署名（分发或对外展示本数据时请保留）**：
> 景点基线数据来自 LAMDA-NeSy/ChinaTravel-Sandbox（CC BY 4.0）。

## 文件

| 文件 | 说明 |
|---|---|
| `attractions.json.gz` | 由 `attractions_zh.parquet` 转换而来，**3,413 条 / 10 城 / 约 78 KB**（gzip，读端自动解压；未压缩约 543 KB） |
| `../../scripts/lib/convert_chintravel.py` | 转换器（需要 `pyarrow`，只需在有新版本时重跑一次） |

**重新生成**：
```
在技能根目录运行：python scripts/lib/convert_chintravel.py <attractions_zh.parquet> --out data/china-travel/attractions.json.gz
（默认就写 `.json.gz`；要未压缩的加 `--no-gzip`。读端 `scripts/spots_baseline.js` 两种都认，优先 `.json`。）
```

## 字段

| 字段 | 含义 | 实测口径 |
|---|---|---|
| `city` / `name` / `type` | 城市 / 景点名 / 类型 | 全表无空值 |
| `lat` / `lon` | 坐标 | WGS-84 |
| `hours` | 开放时间，形如 `08:30-17:00` | 由 `opentime`/`endtime` 合成；**全表无空值** |
| `price` | 门票（人民币元） | float；**`0` = 免费** |
| `visitMin` / `visitMax` | 建议游览时长（小时） | float |

**覆盖的 10 城**：北京 / 成都 / 重庆 / 广州 / 杭州 / 南京 / 上海 / 深圳 / 苏州 / 武汉。

## ⚠ 四条使用边界（务必遵守）

1. **开放时间是「常规时段口径」，不是当日事实。**
   旺季 / 节假日会调整（取消周一闭馆、延时、临时闭馆），且本数据**不含闭馆日字段**。
   → **仍须按技能规则以景区官网最近 1～3 个月的公告核对**；查不到就如实写"以景区公示为准"。
   **基线只用来免去重复检索，不是最终依据。**

2. **建议游览时长口径偏保守，仅供排序参考，不要覆盖查得的结论。**
   实测：本数据给「故宫博物院」`0.5–1h`，而常规攻略普遍为 3～4h。
   → 可用来**初筛/排序**，但**写入方案前应对照攻略修正**。

3. **同批数据集的 `flights` 与 `trains` 表已知有错，本目录只取 `attractions` 表。**
   实测：`flights.FlightID` 是**合成编号** `FL001`（不是真实航班号）；
   `trains` 记「上海站 G2 07:00→11:36 Cost 693.75」，而 12306 实查为
   「上海虹桥 G2 06:43→11:32，二等座 795 / 一等 1272 / 商务 2782」——**站名、时刻、票价都不对**。
   → **绝不可用本数据集供时刻与票价**；铁路一律走 `12306.js`。

4. **技术型来源不进页面**：技能规则是「数据来源只写在聊天回复里，不进网页」——
   所以景点页**不要**写"数据来自 ChinaTravel"（脚本名 / 接口名 / 数据集名同理）；署名保留在本文件与仓库 LICENSE 层面即可。
   **别把这条用过头**：景点页的**评语来源标注**（"来源：马蜂窝 / 去哪儿 游客高频评价归纳"）与自驾讲解页的**官方发布单位 + 年份**属于"内容型来源"，**必须写进页面**。
