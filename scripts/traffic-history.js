#!/usr/bin/env node
/**
 * traffic-history.js —— 「历史高频拥堵段」结论库的聚合器（**只处理我们自己的结论，不碰厂商原始数据**）
 *
 * 为什么要有它：
 *   我们要的不是"某一天的路况"，而是**五年里被反复点名的路段**（大概率拥堵段）。
 *   这类结论只能由**逐年官方公开清单**（交通运输部/省交通运输厅/交警总队/高速集团/权威媒体）统计出来——
 *   厂商只给实时（高德 tmcs）或 90 天历史（付费），给不了五年。
 *   结论（年份×路段×出现次数 + 来源）**可以落盘成我们自己的静态库**；
 *   厂商返回的原始路况/几何数据**一律不得落盘**（技能红线）。
 *
 * 用法:
 *   node scripts/traffic-history.js <segments.json> [--corridor] [--match "G9101,G9102"] [--top 20] [--json]
 *   node scripts/traffic-history.js --check <segments.json>
 *   node scripts/traffic-history.js --selfcheck     # 不联网：自检 window 解析 / 道路归一 / 路段切分
 *   node scripts/traffic-history.js --help
 *
 * 数据文件（我们自己维护，年更）:
 *   {
 *     "window": "2021-2025",
 *     "corridorHighways": ["干线A","干线B","干线C"],
 *     "records": [
 *       { "year": 2023, "holiday": "中秋·国庆", "scope": "全国",
 *         "road": "G9101 甲高速", "segment": "甲省某市段",
 *         "kind": "预测",                       // 预测 | 实测
 *         "publisher": "交通运输部路网中心", "url": "https://…", "publishedAt": "2023-09-28" }
 *     ]
 *   }
 *
 * 退出码: 0 成功；1 用法/数据错误；2 --check 有 FAIL
 */
'use strict';
const fs = require('node:fs');

// 共享正则（--check / 归一化 / --selfcheck 用同一份，避免两处口径漂移）
const WINDOW_RE = /^(\d{4})\s*[-–~～至]\s*(\d{4})$/;
const SPLIT_RE = /[、；;，,]/;
const CODE_RE = /\b((?:G|S)\d{1,4})\b/i;
function parseWindow(v) {
  const m = String(v == null ? '' : v).match(WINDOW_RE);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

const HELP = `traffic-history.js —— 历史高频拥堵段结论库聚合器

用法:
  node scripts/traffic-history.js <segments.json> [--corridor] [--match "G9101,G9102"] [--top 20] [--json]
  node scripts/traffic-history.js --check <segments.json>
  node scripts/traffic-history.js --selfcheck     # 不联网
  node scripts/traffic-history.js --help

选项:
  --corridor   只看与目标走廊相关的高速（按数据文件里的 corridorHighways 匹配）
  --match "G9101,G9102,某互通"   只统计含这些关键词的记录，并给出**缓存判定**
                 HIT  = 覆盖 ≥3 个年份 且 最新年份 ≥ 今年-1 → **跳过检索、直接复用本库**
                 MISS = 否则 → 需要重新收集，收集后**增量写回本库**
  --top N      只列前 N 段（默认 20）
  --json       输出结构化 JSON（便于其它脚本消费）

它做什么:
  1. 归一化道路编号（G9101 甲高速 / 甲高速G9101 → G9101|甲高速）；
  2. 按「道路 + 路段」聚合：统计**被点名的年数**、总条数、其中节后实测条数、逐年出处；
  3. 排序：实测年数 > 总年数 > 条数（节后实测比节前预测权重高）。

口径（硬性）:
  · 数据**只来自公开来源**，每条必须带 url 与 publishedAt；查不到就写「未获取」，不许编造；
  · 本库只存**我们的统计结论 + 来源引用**；厂商原始路况数据不得写进来。
`;

const argv = process.argv.slice(2);
if (!argv.length || argv.includes('--help') || argv.includes('-h')) { process.stdout.write(HELP); process.exit(0); }

// ── --selfcheck：不联网，只验纯函数（window 解析 / 道路编号 / 路段切分）──────────
if (argv[0] === '--selfcheck') {
  let pass = true;
  const ok = (name, cond, extra) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!cond) pass = false; };
  ok('window "2021-2025"', String(parseWindow('2021-2025')) === '2021,2025');
  ok('window en dash "2021–2026"', String(parseWindow('2021–2026')) === '2021,2026');
  ok('window 波浪号 "2021~2025"', String(parseWindow('2021~2025')) === '2021,2025');
  ok('window 非法格式被拒', parseWindow('2021.2025') === null && parseWindow('') === null && parseWindow(undefined) === null);
  ok('道路编号 G80', (('G80 广昆高速'.match(CODE_RE) || [])[1]) === 'G80');
  ok('道路编号 S31 小写转大写', (('s31 平和高速'.match(CODE_RE) || [])[1] || '').toUpperCase() === 'S31');
  ok('不含编号返回 null', ('许广高速'.match(CODE_RE)) === null);
  ok('路段串切分 3 段', 'A、B；C'.split(SPLIT_RE).length === 3);
  console.log(pass ? 'selfcheck PASS' : 'selfcheck FAIL');
  process.exit(pass ? 0 : 1);
}

let checkOnly = false, asJson = false, corridorOnly = false, TOP = 20, file = null;
const need = (i, name) => {
  const v = argv[i + 1];
  if (v === undefined || String(v).startsWith('--')) { console.error(`参数 ${name} 缺少取值（--help 看用法）`); process.exit(1); }
  return v;
};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--check') checkOnly = true;
  else if (a === '--json') asJson = true;
  else if (a === '--corridor') corridorOnly = true;
  else if (a === '--top') { TOP = Number(need(i++, '--top')); if (!Number.isInteger(TOP) || TOP <= 0) { console.error('--top 需要正整数'); process.exit(1); } }
  else if (a === '--match') { need(i++, '--match'); }
  else if (a.startsWith('--')) { console.error(`未知参数: ${a}（--help 看用法）`); process.exit(1); }
  else file = a;
}
if (checkOnly && asJson) { console.error('--check 与 --json 不能同时用（--check 只报合规结果）'); process.exit(1); }
if (!file) { console.error('用法: node scripts/traffic-history.js <segments.json> [--corridor] [--match "G72,G80"] [--top N] [--json] | --check <segments.json> | --selfcheck'); process.exit(1); }
if (!fs.existsSync(file)) { console.error('文件不存在: ' + file); process.exit(1); }
let D;
try { D = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
catch (e) { console.error('JSON 解析失败: ' + e.message); process.exit(1); }
const records = Array.isArray(D.records) ? D.records : [];

// ── --check：数据是否合规（字段齐全、来源可点、年份在窗口内）──────────────
if (checkOnly) {
  const errs = [];
  if (!D.window) errs.push('缺少 window（如 "2021-2025"）');
  if (!records.length) errs.push('records 为空');
  const win = parseWindow(D.window);
  if (D.window && !win) errs.push(`window 格式不对（需要 "2021-2025"，当前 ${JSON.stringify(D.window)}）`);
  const y0 = win ? win[0] : NaN, y1 = win ? win[1] : NaN;
  records.forEach((r, i) => {
    const at = `records[${i}]`;
    for (const k of ['year', 'holiday', 'road', 'segment', 'kind', 'publisher', 'url', 'publishedAt']) {
      if (r[k] === undefined || r[k] === null || String(r[k]).trim() === '') errs.push(`${at} 缺字段 ${k}`);
    }
    if (!Number.isInteger(r.year)) errs.push(`${at} year 不是整数年份（当前 ${JSON.stringify(r.year)}）`);
    else if (win && (r.year < y0 || r.year > y1)) errs.push(`${at} year=${r.year} 不在窗口 ${D.window}`);
    if (r.kind && !['预测', '实测'].includes(r.kind)) errs.push(`${at} kind 只能是 预测/实测（当前 ${r.kind}）`);
    if (r.url && !/^https?:\/\//.test(r.url)) errs.push(`${at} url 不是 http(s): ${r.url}`);
  });
  const years = [...new Set(records.map(r => r.year))].sort();
  console.log(`记录 ${records.length} 条，覆盖年份 ${years.join('/')}，来源 ${new Set(records.map(r => r.publisher)).size} 家`);
  if (errs.length) { errs.slice(0, 20).forEach(e => console.log('  FAIL ' + e)); console.log(`\n${errs.length} FAIL`); process.exit(2); }
  console.log('全部 PASS'); process.exit(0);
}

// ── 归一化 + 聚合 ────────────────────────────────────────────────────────
const CODE = CODE_RE;
const norm = (s) => String(s || '').replace(/\s+/g, '').replace(/[（）]/g, m => (m === '（' ? '(' : ')'));
function splitRoad(road) {
  const t = norm(road);
  const m = t.match(CODE);
  const code = m ? m[1].toUpperCase() : '';
  let name = t.replace(CODE, '').replace(/^[-—·、\s]+|[-—·、\s]+$/g, '');
  return { code, name };
}
const corridor = (D.corridorHighways || []).map(norm);
// 记录里若显式给了 corridor 标记（我们人工判过的"是否在目标走廊上"），以它为准；否则按高速名匹配
const inCorridor = (r) => (typeof r.corridor === 'boolean'
  ? r.corridor
  : corridor.some(c => c && (norm(r.road) + ' ' + norm(r.segment || '')).includes(c)));

// 路段串：一条记录里常写「A、B；C」——**必须拆开**，否则同一段在不同年份写法略有差异就被算成两段
const SPLIT = SPLIT_RE;
const GENERIC_TAIL = /(路段|段|方向|双向|全线|高流量|施工|占道|饱和|出程|返程|通行缓慢|易拥堵|易缓行|（.*?）|\(.*?\))$/;
const GENERIC_WORD = /(互通|枢纽|立交|隧道群|隧道|服务区|停车区|收费站|站|路段|特大桥|大桥|方向|双向|全线|高流量|施工|占道|饱和|出程|返程|爬坡|下沉|匝道|省界|服务区路段)/g;
function normSeg(s) {
  let t = String(s || '').replace(/\s+/g, '').replace(/[（(][^）)]*[）)]/g, '');
  t = t.replace(/[–—\-~至到]/g, '~').replace(/[·。]/g, '');
  for (let i = 0; i < 4; i++) t = t.replace(GENERIC_TAIL, '');
  return t;
}
// 地名关键词：去掉通用词（互通/隧道/服务区…）后剩下的地名，用来把「坛洛站」与「石埠北互通至坛洛路段」归到同一地点组
function extractTokens(s) {
  const t = normSeg(s).replace(GENERIC_WORD, ' ').replace(/[~、,;]/g, ' ');
  return [...new Set(t.split(/\s+/).filter(x => x.length >= 2))];
}
const matchIdx = argv.indexOf('--match');
const MATCH = matchIdx >= 0 ? String(argv[matchIdx + 1] || '').split(/[,，\s]+/).map(norm).filter(Boolean) : null;
const rows = records.filter(r => (!MATCH || MATCH.some(k => (norm(r.road) + norm(r.segment || '')).includes(k)))
  && (corridorOnly ? inCorridor(r) : true));

// 拆成"路段片段"，每片带来源记录
const pieces = [];
for (const r of rows) {
  const { code, name } = splitRoad(r.road);
  for (const p of String(r.segment || '').split(SPLIT).map(s => s.trim()).filter(Boolean)) {
    const key = normSeg(p);
    if (key.length < 2) continue;
    pieces.push({ r, code, name, key, tokens: extractTokens(p), raw: p });
  }
}
// 地点归并：同一高速 + 地名关键词有交集 → 同一「地点组」（并查集）
const parent = pieces.map((_, i) => i);
const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
const union = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[b] = a; };
for (let i = 0; i < pieces.length; i++) {
  for (let j = i + 1; j < pieces.length; j++) {
    if (pieces[i].code !== pieces[j].code) continue;
    if (pieces[i].tokens.some(t => pieces[j].tokens.includes(t))) union(i, j);
  }
}
const groupMap = new Map();
pieces.forEach((pc, i) => {
  const root = find(i);
  if (!groupMap.has(root)) groupMap.set(root, { code: pc.code, name: pc.name, raws: [], records: [], tokens: new Set() });
  const g = groupMap.get(root);
  g.raws.push(pc.raw); g.records.push(pc.r); pc.tokens.forEach(t => g.tokens.add(t));
});
const stats = [...groupMap.values()].map(g => {
  // 同一条记录里「出程…；返程…」命中同一地点组 → 按 (年|节假日|发布方|URL) 去重
  const recs = [...new Map(g.records.map(r => [`${r.year}|${r.holiday}|${r.publisher}|${r.url}`, r])).values()];
  // **日期要区分**：命中单位 = (年 + 节假日)，不是"年"
  const hits = [...new Set(recs.map(r => `${r.year} ${r.holiday}`))].sort();
  const years = [...new Set(recs.map(r => r.year))].sort();
  const realHits = [...new Set(recs.filter(r => r.kind === '实测').map(r => `${r.year} ${r.holiday}`))].sort();
  return {
    road: `${g.code ? g.code + ' ' : ''}${g.name || ''}`.trim(),
    segment: g.raws.sort((a, b) => b.length - a.length)[0],
    aliases: [...new Set(g.raws)].sort((a, b) => b.length - a.length),
    tokens: [...g.tokens],
    hits, years, realHits, n: recs.length,
    sources: [...new Set(recs.map(r => r.publisher))],
    detail: [...recs].sort((a, b) => (a.year - b.year) || String(a.holiday).localeCompare(String(b.holiday)))
      .map(r => `${r.year}·${r.holiday}(${r.kind}) ${r.publisher}`),
    urls: [...new Set(recs.map(r => r.url))],
  };
}).sort((a, b) => (b.hits.length - a.hits.length) || (b.realHits.length - a.realHits.length) || (b.years.length - a.years.length) || (b.n - a.n));

if (asJson) {
  process.stdout.write(JSON.stringify({ window: D.window, corridorOnly, match: MATCH, total: stats.length, stats: stats.slice(0, TOP) }, null, 2) + '\n');
  process.exit(0);
}
if (MATCH) {
  const years = [...new Set(rows.map(r => r.year))].sort();
  const latest = years[years.length - 1];
  const hit = years.length >= 3 && Number(latest) >= new Date().getFullYear() - 1;
  console.log(`# 缓存判定：**${hit ? 'HIT' : 'MISS'}**（关键词 ${MATCH.join('/')}）`);
  console.log(`#   命中记录 ${rows.length} 条 / 覆盖年份 ${years.join('/') || '无'} / 最新 ${latest || '无'}`);
  console.log(`#   判据：覆盖 ≥3 个年份 且 最新年份 ≥ 今年-1 → ${hit ? '**直接复用本库，跳过检索**' : '**需重新收集，收集后增量写回本库**'}`);
  console.log('');
}
console.log(`# 历史高频拥堵段（窗口 ${D.window}${corridorOnly ? ' · 仅走廊相关' : ''}${MATCH ? ' · 关键词 ' + MATCH.join('/') : ''}）`);
console.log(`# 输入 ${records.length} 条记录 → 归并成 ${stats.length} 个地点组；下表前 ${Math.min(TOP, stats.length)} 个`);
console.log('');
console.log('| # | 道路 | 地点组（代表路段原文） | 命中次数 | 命中明细（年·节假日） | 覆盖年份 | 实测 | 别名数 |');
console.log('|---|---|---|---|---|---|---|---|');
stats.slice(0, TOP).forEach((s, i) => {
  console.log(`| ${i + 1} | ${s.road} | ${s.segment} | **${s.hits.length}** | ${s.hits.join('；')} | ${s.years.join('/')} | ${s.realHits.length} | ${s.aliases.length} |`);
});
console.log('');
console.log(`覆盖年份：${[...new Set(records.map(r => r.year))].sort().join('/') || '无'}；来源分布：${[...new Set(records.map(r => r.publisher))].length} 家`);
console.log('⚠ 两条口径：① **命中单位 = 年 + 节假日**（同一年不同节假日算两次）；② 频率只代表"被官方/权威反复点名"，**不等于逐段实测概率**（本库绝大多数为节前预测）；每条记录都能按 url 回溯。');
