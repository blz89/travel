#!/usr/bin/env node
/**
 * spots_peak.js —— 景点路线的「两套方案」：最快（里程最少） vs 避峰（错开人流高峰）
 *
 * 为什么要脚本算：避峰 = 顺序优化 + 时段可行性，两个都可枚举；模型手排既贵又会每次排出不同结果。
 * 判据全部来自数据文件（热门标记 / 开放时间 / 建议时长），不读人流数据、不编造客流曲线。
 *
 * 用法:
 *   node scripts/spots_peak.js <spots-peak.json> [--arrive 09:00] [--start <起点名>]
 *        [--holiday] [--speed 24] [--max-detour 20] [--json]
 *   node scripts/spots_peak.js <spots-peak.json> --emit-plan <itin-data.json> --out <data.json>
 *
 * spots-peak.json:
 *   { start: "武汉站", arrive: "09:00", dist: {"A":{"B":3.2}, ...},
 *     spots: [{ name, hot: true, open: "08:30", close: "17:00", dwellH: 2.5 }, ...] }
 *   · hot 缺省 = false；open/close 缺省 = 08:30 / 17:30；dwellH 缺省 = 2.5
 *   · dist 与 itinerary.js 同形（可先跑 itinerary.js dist 生成）
 *
 * 输出:
 *   ① 最快方案（最近邻 · 里程最少）② 避峰方案（低峰窗优先）③ 两方案差值 ④ 退让原因（若触发）
 *   末行: PEAK fastest_km=30.6 peak_km=34.1 detour=11.4% fallback=no
 * 退出码: 0 正常（含"避峰退回最快"）/ 1 数据不足（缺 dist、spots<2）/ 2 用法错误
 *
 * 注意: 不要读本脚本源码——用 --help 就够了。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const HELP = [
  'spots_peak.js —— 景点路线两套方案：最快（里程最少） vs 避峰（错开人流高峰）',
  '',
  '用法:',
  '  node scripts/spots_peak.js <spots-peak.json> [--arrive 09:00] [--start <起点>] [--holiday]',
  '        [--speed 24] [--max-detour 20] [--json]',
  '  node scripts/spots_peak.js <spots-peak.json> --emit-plan <itin-data.json> --out <data.json>',
  '',
  '输入字段: start / arrive / dist / spots[{name, hot, open, close, dwellH}]',
  '  缺省: arrive=09:00、open=08:30、close=17:30、dwellH=2.5、hot=false',
  '',
  '判据（全部来自数据，不读客流数据）:',
  '  · 低峰窗 = 开园后 120 分钟 或 闭园前 150 分钟（两个窗口，取更近的一个）',
  '  · 热门景点（hot=true）优先落进低峰窗；不热门景点用来填缝',
  '  · 顺序代价 = 里程(km) + 0.15 × 错过低峰窗的分钟数 + 3 × 热门错位',
  '  · 避峰里程增幅 > --max-detour%（默认 20）或有时段不可行 → 退回最快方案并说明原因',
  '  · 节假日（--holiday）时把"热门优先"的权重翻倍（人更多，错峰更值），其余不变',
  '',
  '输出末行: PEAK fastest_km=… peak_km=… detour=…% fallback=yes|no',
  '退出码: 0 正常（含退让）/ 1 数据不足 / 2 用法错误',
  '',
  '注意: 不要读本脚本源码——用 --help 就够了。',
].join('\n');

const argv = process.argv.slice(2);
if (!argv.length || argv.includes('--help') || argv.includes('-h')) { console.log(HELP); process.exit(argv.length ? 0 : 2); }
const opt = (n, dflt) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt; };
const flags = new Set(argv.filter((a) => a.startsWith('--')));
const asJson = argv.includes('--json');
const HOLIDAY = argv.includes('--holiday');
const file = argv.find((a) => !a.startsWith('--') && a !== opt('--arrive') && a !== opt('--start') && a !== opt('--speed') && a !== opt('--max-detour') && a !== opt('--emit-plan') && a !== opt('--out'));
if (!file) { console.error('用法: node scripts/spots_peak.js <spots-peak.json>（--help 看完整说明）'); process.exit(2); }
if (!fs.existsSync(file)) { console.error('文件不存在: ' + file); process.exit(2); }

let d;
try { d = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
catch (e) { console.error('JSON 解析失败: ' + e.message); process.exit(2); }

const mm = (s, dflt) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
  if (!m) return dflt;
  return Number(m[1]) * 60 + Number(m[2]);
};
const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(Math.round(min % 60)).padStart(2, '0')}`;

const SPEED = Number(opt('--speed', 24));            // km/h，城市内景点间移动
const MAX_DETOUR = Number(opt('--max-detour', 20));  // 避峰允许的里程增幅上限（%）
const ARRIVE_RAW = String(opt('--arrive', d.arrive || '09:00')).trim();
if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(ARRIVE_RAW)) { console.error(`--arrive 需要 HH:MM（00:00–23:59），收到 "${ARRIVE_RAW}"`); process.exit(2); }
if (!Number.isFinite(MAX_DETOUR) || MAX_DETOUR < 0 || MAX_DETOUR > 200) { console.error(`--max-detour 需要 0–200 的数字（%），收到 "${opt('--max-detour')}"`); process.exit(2); }
if (!Number.isFinite(SPEED) || SPEED <= 0) { console.error(`--speed 需要正数（km/h），收到 "${opt('--speed')}"`); process.exit(2); }
const ARRIVE = mm(ARRIVE_RAW, 9 * 60);
const W_A = 0.15;                                     // 每错过低峰窗 1 分钟的代价（km）
const W_HOT = HOLIDAY ? 6 : 3;                        // 热门错位代价（km）；节假日翻倍
const DWELL_DEFAULT = 2.5;

if (Array.isArray(d.spots) && d.spots.some((x) => typeof x === 'string')) {
  const bad = d.spots.map((x, i) => (typeof x === 'string' ? 'spots[' + i + ']=' + JSON.stringify(x) : null)).filter(Boolean).slice(0, 3).join('、');
  console.error('spots 里混了字符串：' + bad + `（共 ${d.spots.length} 项）——需要对象 {name, hot?, open?, close?, dwellH?}。`);
  process.exit(2);
}
const spots = (Array.isArray(d.spots) ? d.spots : []).map((s) => {
  const o = typeof s === 'string' ? { name: s } : Object.assign({}, s);
  return {
    name: String(o.name || ''),
    hot: o.hot === true || o.hot === 'true',
    open: mm(o.open, 8 * 60 + 30),
    close: mm(o.close, 17 * 60 + 30),
    dwell: (Number(o.dwellH) > 0 ? Number(o.dwellH) : DWELL_DEFAULT) * 60,
  };
}).filter((s) => s.name);
const names = spots.map((s) => s.name);
const START = String(opt('--start', d.start || d.inputStart || '起点'));
const dist = d.dist || {};

if (names.length < 2) { console.error('至少给 2 个景点（spots 太少了）'); process.exit(1); }

function detourWord(p) {
  if (p === null || p === undefined) return '里程差未知';
  return p < 0 ? `比最快少 ${-p}%` : `比最快多 ${p}%`;
}
function km(a, b) {
  if (a === b) return 0;
  const ab = dist[a] && dist[a][b], ba = dist[b] && dist[b][a];
  const v = ab !== undefined && ab !== null ? ab : ba;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
const miss = [];
for (let i = 0; i < names.length; i++) {
  if (km(START, names[i]) === null) miss.push(`${START} → ${names[i]}`);
  for (let j = i + 1; j < names.length; j++) if (km(names[i], names[j]) === null) miss.push(`${names[i]} → ${names[j]}`);
}
if (miss.length) {
  console.error(`缺距离（共 ${miss.length} 对），请补进 dist：`);
  miss.slice(0, 10).forEach((m) => console.error('  ' + m));
  if (miss.length > 10) console.error(`  … 另有 ${miss.length - 10} 对`);
  process.exit(1);
}

const travelMin = (a, b) => Math.round((km(a, b) / SPEED) * 60);
const byName = new Map(spots.map((s) => [s.name, s]));

// 最近邻（与 itinerary.js 同一口径：只按里程，确定性的"最快"）
function nearestNeighbor() {
  const order = [];
  const left = new Set(names);
  let cur = START;
  while (left.size) {
    let best = null, bestD = Infinity;
    for (const n of [...left].sort()) { const v = km(cur, n); if (v < bestD) { bestD = v; best = n; } }
    order.push(best); left.delete(best); cur = best;
  }
  return order;
}

// 时刻推演：返回 {rows, feasible, kmTotal}
function simulate(order) {
  let t = ARRIVE, cur = START, kmTotal = 0;
  const rows = [];
  for (const n of order) {
    const s = byName.get(n);
    const legKm = km(cur, n); kmTotal += legKm;
    let tIn = t + travelMin(cur, n);
    let waited = 0;
    if (tIn < s.open) { waited = s.open - tIn; tIn = s.open; }
    const tOut = tIn + s.dwell;
    if (tOut > s.close) return { rows, feasible: false, kmTotal, reason: `${n} 来不及（${hhmm(tIn)} 入场 + ${Math.round(s.dwell / 60 * 10) / 10}h 超过 ${hhmm(s.close)} 闭园）` };
    rows.push({ name: n, hot: s.hot, tIn, tOut, waited, legKm, window: windowOf(s, tIn), label: labelOf(s, tIn) });
    t = tOut; cur = n;
  }
  return { rows, feasible: true, kmTotal: Math.round(kmTotal * 10) / 10 };
}

function lowWindows(s) {
  const a = [s.open, Math.min(s.open + 120, s.close)];
  const b = [Math.max(s.close - 150, s.open), s.close];
  return [a, b];
}
function windowMiss(s, tIn) {
  const w = lowWindows(s);
  let best = Infinity;
  for (const [st, en] of w) {
    if (tIn >= st && tIn <= en) return 0;
    best = Math.min(best, tIn < st ? st - tIn : tIn - en);
  }
  return best;
}
function windowOf(s, tIn) {
  const [a, b] = lowWindows(s);
  if (tIn >= a[0] && tIn <= a[1]) return 'A';
  if (tIn >= b[0] && tIn <= b[1]) return 'B';
  return '-';
}
function labelOf(s, tIn) {
  const w = windowOf(s, tIn);
  if (w === 'A') return `开园后低峰（${hhmm(s.open)}–${hhmm(Math.min(s.open + 120, s.close))}）`;
  if (w === 'B') return `闭园前低峰（${hhmm(Math.max(s.close - 150, s.open))}–${hhmm(s.close)}）`;
  return '中段人流（无公开客流数据，按开闭园时间推断）';
}

// 避峰：贪心（里程 + 低峰窗惩罚 + 热门错位），同分按名字保证确定性
// 单步贪心：给定已走顺序，挑"里程 + 低峰窗惩罚 + 热门错位"最低的下一个
function greedyAfter(seed) {
  const order = seed ? [seed] : [];
  const left = new Set(names.filter((n) => !order.includes(n)));
  let cur = order.length ? order[0] : START;
  let t = ARRIVE;
  if (order.length) {
    const s0 = byName.get(order[0]);
    const tIn = t + travelMin(START, order[0]);
    t = Math.max(tIn, s0.open) + s0.dwell;
    if (t > s0.close) return null;
  }
  while (left.size) {
    let best = null, bestScore = Infinity;
    for (const n of [...left].sort()) {
      const s = byName.get(n);
      const arriveAt = Math.max(t + travelMin(cur, n), s.open);
      if (arriveAt + s.dwell > s.close) continue;
      const missMin = s.hot ? windowMiss(s, arriveAt) : 0;
      const hotMiss = s.hot && windowOf(s, arriveAt) === '-' ? 1 : 0;
      const score = km(cur, n) + W_A * missMin + W_HOT * hotMiss;
      if (score < bestScore) { bestScore = score; best = n; }
    }
    if (!best) return null;
    const s = byName.get(best);
    t = Math.max(t + travelMin(cur, best), s.open) + s.dwell;
    order.push(best); left.delete(best); cur = best;
  }
  return order;
}

// 总代价：里程 + 0.15×热门错过低峰窗的分钟数 + W_HOT×热门落入中段（与单步同口径）
function orderCost(sim) {
  let c = sim.kmTotal;
  for (const r of sim.rows) {
    const s = byName.get(r.name);
    if (!s.hot) continue;
    const w = windowOf(s, r.tIn);
    if (w === '-') { c += W_HOT; c += W_A * windowMiss(s, r.tIn); }
  }
  return Math.round(c * 100) / 100;
}

// 多起点贪心：每个景点都当一次首站试（n≤10，代价可忽略），取总代价最小；同分保持首个
function peakOrder() {
  let best = null, bestCost = Infinity;
  for (const seed of [...names].sort()) {
    const o = greedyAfter(seed);
    if (!o) continue;
    const sim = simulate(o);
    if (!sim.feasible) continue;
    const cost = orderCost(sim);
    if (cost < bestCost - 1e-9) { bestCost = cost; best = o; }
  }
  return best;
}

const fastOrder = nearestNeighbor();
const fast = simulate(fastOrder);
if (!fast.feasible) {
  // 连"里程最少"的顺序都塞不进当天开放时间 → 这不是避峰问题，是行程本身不可行
  console.error('最快方案本身排不进当天开放时间：' + fast.reason);
  console.error('→ 先减景点、提前出发，或改用两天分别安排；不要硬排。');
  process.exit(1);
}
const peakO = peakOrder();
const peak = peakO ? simulate(peakO) : null;
const detourPct = peak && fast.kmTotal > 0 ? Math.round((1000 * (peak.kmTotal - fast.kmTotal)) / fast.kmTotal) / 10 : null;

let fallback = false, fallbackWhy = '';
if (!peak) { fallback = true; fallbackWhy = '避峰顺序不成立（有景点塞不进当天开放时间）'; }
else if (!peak.feasible) { fallback = true; fallbackWhy = peak.reason; }
else if (detourPct !== null && detourPct > MAX_DETOUR) { fallback = true; fallbackWhy = `避峰要多跑 ${detourPct}%（上限 ${MAX_DETOUR}%），性价比不成立`; }

const payload = {
  start: START, arrive: hhmm(ARRIVE), holiday: HOLIDAY,
  speedKmh: SPEED, maxDetourPct: MAX_DETOUR,
  fastest: { order: fastOrder, km: fast.kmTotal, rows: fast.rows.map((r) => ({ name: r.name, in: hhmm(r.tIn), out: hhmm(r.tOut), window: r.window, label: r.label })) },
  peak: peak && peak.feasible ? { order: peakO, km: peak.kmTotal, rows: peak.rows.map((r) => ({ name: r.name, in: hhmm(r.tIn), out: hhmm(r.tOut), window: r.window, label: r.label })) } : null,
  detourPct, fallback, fallbackWhy,
};

if (asJson) {
  console.log(JSON.stringify(payload, null, 2));
} else {
  const line = (r, i) => `  ${String(i + 1).padStart(2)}. ${r.name}${r.hot ? '（热门）' : ''}  ${hhmm(r.tIn)}–${hhmm(r.tOut)}  ${r.label}`;
  console.log(`# 起点「${START}」· 到达 ${hhmm(ARRIVE)} · 车程按 ${SPEED} km/h · ${HOLIDAY ? '节假日' : '非节假日'}`);
  console.log(`\n== 方案 A · 最快（里程最少，最近邻）==  总里程 ${fast.kmTotal} km`);
  fast.rows.forEach((r, i) => console.log(line(r, i)));
  if (peak && peak.feasible && !fallback) {
    console.log(`\n== 方案 B · 避峰（热门优先落低峰窗）==  总里程 ${peak.kmTotal} km（比最快多 ${detourPct}%）`);
    peak.rows.forEach((r, i) => console.log(line(r, i)));
    console.log('\n  避峰为什么这么排：热门景点优先塞进「开园后 120 分钟」或「闭园前 150 分钟」，不热门景点用来填缝；');
    console.log('  两方案对比卡里如实写里程与时间差，由客户选。');
  } else if (peak && peak.feasible) {
    // 排得出来但超了客户能接受的里程增幅 → 作为"备选"如实列出，让客户决定要不要
    console.log(`\n== 方案 B · 避峰（备选，超里程上限）==  总里程 ${peak.kmTotal} km（${detourWord(detourPct)}）`);
    peak.rows.forEach((r, i) => console.log(line(r, i)));
    console.log(`\n  退让原因：${fallbackWhy}`);
    console.log('  → 默认只交付方案 A；**只有当客户明确说"愿意多跑路换人少"时**，才把方案 B 一起给，并写清多跑多少。');
  } else {
    console.log(`\n== 方案 B · 避峰 ==  不成立：${fallbackWhy}`);
    console.log('  → 只交付方案 A（最快），并在页面注明"本线路避峰不成立，原因如上"，不要硬排。');
  }
  console.log(`\nPEAK fastest_km=${fast.kmTotal} peak_km=${peak && peak.feasible ? peak.kmTotal : '-'} detour=${detourPct === null ? '-' : detourPct + '%'} fallback=${fallback ? 'yes' : 'no'}`);
}

// --emit-plan：把两套方案写进行程页 data.json（覆盖 plans[] 与 footnotes），供 make_html itin 渲染
const emitPlan = opt('--emit-plan', null);
if (emitPlan) {
  if (!fs.existsSync(emitPlan)) { console.error('找不到要合并的 data.json: ' + emitPlan); process.exit(2); }
  let base;
  try { base = JSON.parse(fs.readFileSync(emitPlan, 'utf8').replace(/^\uFEFF/, '')); }
  catch (e) { console.error('合并目标不是合法 JSON: ' + e.message); process.exit(2); }
  // 交通方式从并入的 data.json 继承（别再硬编码 mixed：巴士/打车页会渲染成空）
  const srcMode = (Array.isArray(base.plans) && base.plans[0] && base.plans[0].mode) || base.mode || 'mixed';
  const cards = [
    { title: '方案 A · 最快（里程最少）', mode: srcMode, note: `总里程 ${fast.kmTotal} km；顺序按最近邻，只优化路程。` },
  ];
  if (peak && peak.feasible && !fallback) {
    cards.push({ title: '方案 B · 避峰（错开人流高峰）', mode: srcMode, note: `总里程 ${peak.kmTotal} km（${detourWord(detourPct)}）；把热门景点优先安排到开园后 / 闭园前的低峰窗，不热门景点填缝。` });
  }
  base.plans = cards;
  const fn = Array.isArray(base.overview && base.overview.footnotes) ? base.overview.footnotes : [];
  fn.push(`最快方案按里程最近邻排（${fast.kmTotal} km）${peak && peak.feasible && !fallback ? `；避峰方案把热门景点错到低峰窗（${peak.kmTotal} km，多 ${detourPct}%）` : `；本线路避峰不成立：${fallbackWhy}`}。`);
  if (base.overview) base.overview.footnotes = fn;
  const out = opt('--out', emitPlan.replace(/\.json$/, '') + '.plans.json');
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(base, null, 2) + '\n', 'utf8');
  console.log(`\n已写出 ${out}（plans 已写入 ${cards.length} 张卡、overview.footnotes 已追加）`);
  console.log('提示：对比卡还缺 price（两方案人均价）与 taxiLegs（每段方式/耗时），按 references/phase-2-itinerary.md 补齐后再跑 gate——骨架页现在会被 A5 占位门禁拦住。');
}
process.exitCode = 0;
