#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把 ChinaTravel-Sandbox 的 attractions parquet 转成技能内的静态 JSON。

为什么转 JSON 而不是直接读 parquet：
  技能现在是**纯 Node、零依赖**（不装 npm 包）。Node 原生读不了 parquet，
  转成 JSON 后就能被 `scripts/spots_baseline.js` 直接 require —— 零依赖、零网络、零配额。

用法:
  python scripts/lib/convert_chintravel.py <attractions_zh.parquet> [--out <attractions.json>]

数据来源与许可（**必须随数据一起保留**）：
  LAMDA-NeSy/ChinaTravel-Sandbox · License: CC BY 4.0
  https://github.com/LAMDASZ-ML/ChinaTravel  ·  arXiv:2412.13682
  形如 CC BY 4.0，可缓存 / 可商用 / 可再分发，**需署名**。
"""
import argparse
import json
import os
import sys
from collections import Counter


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("parquet", help="attractions_zh.parquet 路径")
    ap.add_argument("--out", default=None, help="输出 JSON 路径（默认与 parquet 同目录的 attractions.json）")
    args = ap.parse_args()

    try:
        import pyarrow.parquet as pq
    except ImportError:
        print("需要 pyarrow：pip install pyarrow", file=sys.stderr)
        return 1

    src = args.parquet
    if not os.path.exists(src):
        print(f"找不到文件: {src}", file=sys.stderr)
        return 1
    out = args.out or os.path.join(os.path.dirname(os.path.abspath(src)), "attractions.json")

    t = pq.read_table(src)
    rows = t.to_pylist()

    # 规范化：只保留技能用得上的字段；时间统一成 "HH:MM-HH:MM"；
    # price 为 0 表示免费（实测某景点 0.0），保留原义交给上层渲染。
    spots = []
    for r in rows:
        ot, et = (r.get("opentime") or "").strip(), (r.get("endtime") or "").strip()
        hours = f"{ot}-{et}" if ot and et else ("全天" if (ot or et) else "")
        price = r.get("price")
        spots.append({
            "city": r.get("city"),
            "name": r.get("name"),
            "type": r.get("type"),
            "lat": round(r["lat"], 6) if r.get("lat") is not None else None,
            "lon": round(r["lon"], 6) if r.get("lon") is not None else None,
            "hours": hours,
            "price": (round(float(price), 1) if price is not None else None),
            "visitMin": r.get("recommendmintime"),
            "visitMax": r.get("recommendmaxtime"),
        })

    by_city = Counter(s["city"] for s in spots)
    payload = {
        "_source": {
            "dataset": "LAMDA-NeSy/ChinaTravel-Sandbox",
            "license": "CC BY 4.0",
            "repo": "https://github.com/LAMDASZ-ML/ChinaTravel",
            "paper": "arXiv:2412.13682",
            "note": "开放时间为**常规时段口径**（旺季/节假日会调整）——仍须按技能规则以景区官网公告核对；本基线只用于免去重复检索。",
            "caveat": "本数据集同批的 flights/trains 表已知有错（合成航班号、时刻票价与 12306 不符），**本文件只取 attractions 表**。",
        },
        "cities": sorted(by_city.keys()),
        "counts": {c: by_city[c] for c in sorted(by_city.keys())},
        "spots": spots,
    }

    with open(out, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))

    size = os.path.getsize(out)
    print(f"已写出 {out}")
    print(f"  景点 {len(spots)} 条 · 城市 {len(by_city)} 个 · {size / 1024:.0f} KB")
    for c in sorted(by_city):
        print(f"    {c}: {by_city[c]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
