#!/usr/bin/env node
/**
 * itinerary.js —— 行程串联顺序（最近邻）+ 错峰可行性判定
 *
 * 用法: node scripts/itinerary.js <plan.json> [--start <名称>] [--json]
 *       node scripts/itinerary.js --help
 *
 * 为什么要有这个脚本：
 *   段落顺序是**确定性算法**——给定两两距离，顺序唯一。让模型在文字里排，
 *   等于"用 token 生成来排序"，既贵又可能每次排得不一样（见 SKILL.md「行程方案规则」）。
 *
 * 输入 JSON:
 *   {
 *     "start": "北京南站",                     // 起点：到达站 / 机场 / 市中心 / 高速路口
 *     "spots": ["天安门", "故宫", "天坛", ...], // 待串联的景点（用户选定的）
 *     "dist": {                                // 两两距离（km），由地图查询得到
 *       "北京南站": { "天安门": 8.2, "故宫": 8.5 },
 *       "天安门":   { "故宫": 1.2, "天坛": 4.8 }
 *     },
 *     "inputStart": "天安门"                   // 可选：用户自己指定的首个景点（选项②）
 *   }
 *   dist 只需给"起点→各景点"与"景点→景点"的单向值；脚本按对称处理，缺哪边用另一边补。
 *
 * 退出码: 0 = 成功；1 = 用法/数据错误
 */
'use strict';
const fs = require('node:fs');

const HELP = [
  'itinerary.js —— 行程串联顺序（最近邻）+ 错峰可行性判定',
  '',
  '用法:',
  '  node scripts/itinerary.js <plan.json> [--start <名称>] [--json]',
  '  node scripts/itinerary.js dist <anchors.json> [--margin 1.15] [--out <dist.json>]',
  '',
  '选项:',
  '  --start <名称>   覆盖 JSON 里的 start（起点：到达站 / 机场 / 市中心 / 高速路口）',
  '  --gap <km>       错峰可行性阈值，默认 20（相邻两景区间隔 ≤ 此值才可串成一条线）',
  '  --json           输出结构化 JSON',
  '  --help, -h       显示本说明',
  '',
  'dist 模式（**查不到地图路线时先用它**）:',
  '  你只查「每个景点距锚点（到达站/机场/市中心）多少公里」，矩阵由脚本算——',
  '  输入 { "start": "敦煌站", "spots": [ {"name":"莫高窟","km":25,"dir":"SE"}, … ] }',
  '  · **尽量给每个景点带上 dir（方位）**：N/NE/E/SE/S/SW/W/NW 或角度（如 135）。',
  '    给了方位 → 脚本用**余弦定理**算两两距离，可信；',
  '    没给方位 → 只能退回「里程差值 × 余量」，**它只在两点同向时成立，不同向会严重低估**',
  '    （实测：甲景区与乙景区离某站都约 25km 但方向不同，差值法给 3.5km，实际约 25～28km）。',
  '  · 无论哪种算法都是**估算**，页面与聊天里必须注明"里程为参考约数"。',
  '',
  '它做什么:',
  '  1. 定首个景点：JSON 里给了 inputStart 就用它（用户选项②）；否则取距 start 最近的那个（选项①）。',
  '  2. 之后按最近邻逐个串联剩余景点（每次从剩余里取距离最近的一个）。',
  '  3. 给出每段里程与总里程。',
  '  4. 判定错峰可行性：相邻两景区间隔是否都 ≤ --gap（默认 20km）。',
  '',
  '输入 JSON 形状:',
  '  {',
  '    "start": "北京南站",',
  '    "inputStart": "天安门",            // 可选',
  '    "spots": ["天安门", "故宫", "天坛"],',
  '    "dist": { "北京南站": { "天安门": 8.2 }, "天安门": { "故宫": 1.2 } }',
  '  }',
  '  dist 只需给单向值，脚本按对称处理（缺哪边用另一边补）。',
  '',
  '输出:',
  '  串联顺序（起点 → 景点1 → 景点2 …）、每段里程、总里程、错峰可行性结论。',
  '',
  '退出码: 0 = 成功；1 = 用法 / 数据错误（如景点缺距离、两景点之间无路可查）。',
  '',
  '注意: 不要读本脚本源码——用 --help 就够了。',
].join('\n') + '\n';

// ── dist 模式：由"每处距同一锚点"的里程推出两两距离矩阵 ──────────────────
// 为什么要有：SKILL.md 允许在查不到地图路线时"用同一锚点推算——两两取差值并留一点余量"，
// 但那是纯减法，从前由执行者手算 N²/2 对（5～8 个景点就是 10～28 对），四轮实测全是摩擦点。
// 现在执行者只负责查"每个景点距锚点多少公里"（判断+取数），矩阵交给代码。
// 方位：可选。**给了方位才算得对**——只给里程时 |a−b| 只在两点同向时成立，
// 不同向会严重低估（实测：甲景区与乙景区离某站都约 25km 但方向不同，
// 差值法算出 3.5km，实际约 25～28km）。给了方位就走余弦定理。
const COMPASS = { N: 0, NE: 45, E: 90, SE: 135, S: 180, SW: 225, W: 270, NW: 315 };
function dirDeg(v) {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v).trim().toUpperCase();
  if (COMPASS[s] !== undefined) return COMPASS[s];
  const n = Number(s.replace(/[°度]/g, ''));
  return Number.isFinite(n) ? ((n % 360) + 360) % 360 : null;
}

function distMain(file, margin, outFile, asJson) {
  if (!file) { console.error('用法: node scripts/itinerary.js dist <anchors.json> [--margin 1.15] [--out <dist.json>]'); process.exit(1); }
  if (!fs.existsSync(file)) { console.error('文件不存在: ' + file); process.exit(1); }
  let d;
  // 容忍 UTF-8 BOM（PowerShell here-string 写出的 JSON 常带 BOM）
  try { d = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
  catch (e) { console.error('JSON 解析失败: ' + e.message); process.exit(1); }
  const start = d.start;
  const list = Array.isArray(d.spots) ? d.spots : [];
  if (!start) { console.error('缺少 start（锚点：到达站 / 机场 / 市中心）'); process.exit(1); }
  if (list.length < 2) { console.error('spots 至少 2 个（每个给 {name, km}，km = 距锚点的里程；有方位就带上 dir）'); process.exit(1); }
  const bad = list.filter(s => !s || !s.name || !Number.isFinite(Number(s.km)));
  if (bad.length) { console.error('每项必须给 name 与数字 km，有问题的是：' + JSON.stringify(bad)); process.exit(1); }
  const r5 = (v) => Math.round(v * 2) / 2;   // 取到 0.5 km，别假装精确
  const m = Number.isFinite(margin) && margin > 0 ? margin : 1.15;
  const dist = {};
  let crude = 0, total = 0;
  dist[start] = {};
  for (const s of list) dist[start][s.name] = Number(s.km);
  for (let i = 0; i < list.length; i++) {
    dist[list[i].name] = {};
    for (let j = i + 1; j < list.length; j++) {
      const a = Number(list[i].km), b = Number(list[j].km);
      const da = dirDeg(list[i].dir), db = dirDeg(list[j].dir);
      total++;
      let v;
      if (da !== null && db !== null) {
        // 余弦定理：两点都相对锚点有方位时，这是正确做法
        const th = Math.abs(da - db) * Math.PI / 180;
        v = Math.sqrt(a * a + b * b - 2 * a * b * Math.cos(th));
      } else {
        // 没给方位 → 退回差值法，但**它只是下限**，不同向时会严重低估
        v = Math.abs(a - b) * m; crude++;
      }
      dist[list[i].name][list[j].name] = r5(v);
    }
  }
  if (outFile) { try { fs.writeFileSync(outFile, JSON.stringify(dist, null, 2), 'utf8'); } catch (e) { console.error('写出失败: ' + e.message); process.exit(1); } }
  if (asJson) { process.stdout.write(JSON.stringify(dist, null, 2) + '\n'); process.exit(0); }
  const L = [];
  L.push(`# 距离矩阵（锚点：${start}）`);
  L.push('  ' + `锚点 → ` + list.map(s => `${s.name} ${s.km}km${dirDeg(s.dir) !== null ? '(' + s.dir + ')' : ''}`).join(' ｜ '));
  L.push('  景点两两：');
  for (let i = 0; i < list.length; i++)
    for (let j = i + 1; j < list.length; j++)
      L.push(`    ${list[i].name} ↔ ${list[j].name}  ${dist[list[i].name][list[j].name]} km`);
  L.push('');
  if (crude) {
    L.push(`⚠ ${crude}/${total} 对是**差值法**（其中一方没给方位）——它只在两点同向时成立，**不同向会严重低估**。`);
    L.push('  实测踩过：甲景区与乙景区离某站都约 25km 但方向不同，差值法给 3.5km，实际约 25～28km。');
    L.push('  **建议给每个景点补上 dir**（N/NE/E/SE/S/SW/W/NW 或角度，如 "SE" 或 135）——给了方位就走余弦定理，结果才可信。');
  } else {
    L.push('✔ 全部成对都用余弦定理算（每个景点都给了方位），结果可信。');
  }
  L.push('');
  L.push(outFile ? `已写出 ${outFile}` : '（加 --out <文件> 可落盘成 dist 对象）');
  L.push('⚠ 无论哪种算法都是**估算**，页面与聊天里必须注明"里程为参考约数"。');
  process.stdout.write(L.join('\n') + '\n');
  process.exit(0);
}

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) { process.stdout.write(HELP); process.exit(0); }

let file = null, startOverride = null, gap = 20, asJson = false, margin = 1.15, outFile = null, mode = 'chain';
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--start') startOverride = argv[++i];
  else if (a === '--gap') gap = Number(argv[++i]);
  else if (a === '--margin') margin = Number(argv[++i]);
  else if (a === '--out') outFile = argv[++i];
  else if (a === '--json') asJson = true;
  else if (a === 'dist') mode = 'dist';
  else if (!a.startsWith('--')) file = a;
  else { console.error('未知参数: ' + a + '（--help 看用法）'); process.exit(1); }
}
if (mode === 'dist') distMain(file, margin, outFile, asJson);
if (!file) { console.error('用法: node scripts/itinerary.js <plan.json> [--start <名称>] [--json]（--help 看完整说明）'); process.exit(1); }
if (!fs.existsSync(file)) { console.error('文件不存在: ' + file); process.exit(1); }
if (!Number.isFinite(gap) || gap <= 0) { console.error('--gap 必须是正数'); process.exit(1); }

let d;
try { d = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
catch (e) { console.error('JSON 解析失败: ' + e.message); process.exit(1); }

const start = startOverride || d.start;
const rawSpots = Array.isArray(d.spots) ? d.spots.map(String) : [];
// 起点若本身就是景点之一，说明用户人已经在那里——它不该再算作"要走一段才能到"的站。
// 例：--start 故宫、而 spots 里也有故宫时，故宫从待串联列表里移除，避免出现「故宫 ← 故宫 0 km」。
const spots = rawSpots.filter(s => s !== start);
const startWasSpot = rawSpots.length !== spots.length;
const dist = d.dist || {};
if (!start) { console.error('缺少 start（起点）'); process.exit(1); }
if (spots.length < 1) {
  console.error(startWasSpot
    ? `去掉起点「${start}」后没有其他景点了（spots 里只有它自己）。`
    : 'spots 至少要有 1 个景点');
  process.exit(1);
}

// 对称距离查询；缺哪边用另一边补；都没有则报错
function km(a, b) {
  if (a === b) return 0;
  const ab = dist[a] && dist[a][b];
  const ba = dist[b] && dist[b][a];
  const v = (ab !== undefined && ab !== null) ? ab : ba;
  if (v === undefined || v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
const missing = [];
for (let i = 0; i < spots.length; i++) {
  if (km(start, spots[i]) === null) missing.push(`${start} → ${(spots[i] && spots[i].name) || spots[i]}`);
  for (let j = i + 1; j < spots.length; j++) {
    if (km(spots[i], spots[j]) === null) missing.push(`${spots[i]} → ${spots[j]}`);
  }
}
if (missing.length) {
  console.error(`缺距离（共 ${missing.length} 对），请补进 dist：`);
  missing.slice(0, 12).forEach(m => console.error('  ' + m));
  if (missing.length > 12) console.error(`  … 另有 ${missing.length - 12} 对`);
  process.exit(1);
}

// 1. 定首个景点
let first, firstWhy;
if (d.inputStart && spots.includes(String(d.inputStart))) {
  first = String(d.inputStart); firstWhy = '用户自己指定（选项②）';
} else {
  if (d.inputStart) console.error(`提示: inputStart「${d.inputStart}」不在 spots 里，改按最近原则取首站。`);
  first = spots.reduce((best, s) => (km(start, s) < km(start, best) ? s : best), spots[0]);
  firstWhy = `距起点「${start}」最近（选项①）`;
}

// 2. 最近邻串联
const order = [first];
const left = new Set(spots.filter(s => s !== first));
while (left.size) {
  const cur = order[order.length - 1];
  let best = null, bestD = Infinity;
  for (const s of left) { const v = km(cur, s); if (v < bestD) { bestD = v; best = s; } }
  order.push(best); left.delete(best);
}

// 3. 逐段里程
const legs = [{ from: start, to: order[0], km: km(start, order[0]) }];
for (let i = 1; i < order.length; i++) legs.push({ from: order[i - 1], to: order[i], km: km(order[i - 1], order[i]) });
const total = Math.round(legs.reduce((s, l) => s + l.km, 0) * 10) / 10;

// 4. 错峰可行性：相邻两景区间隔是否都 ≤ gap（起点那一段不计入）
const spotLegs = legs.slice(1);
const over = spotLegs.filter(l => l.km > gap);
const gapOk = over.length === 0;

if (asJson) {
  process.stdout.write(JSON.stringify({
    start, first, firstWhy, order, legs, totalKm: total,
    gapThreshold: gap, gapFeasible: gapOk,
    overGap: over.map(l => ({ from: l.from, to: l.to, km: l.km })),
  }, null, 1) + '\n');
} else {
  const L = [];
  L.push(`# 串联顺序（起点「${start}」，共 ${order.length} 个景点，总里程 ${total} km）`);
  L.push(`# 首站「${first}」来源：${firstWhy}`);
  if (startWasSpot) L.push(`# 注：「${start}」同时出现在起点与 spots 里，已按"人已在起点"从待串联列表移除。`);
  L.push('');
  order.forEach((s, i) => {
    const leg = legs[i];
    L.push(`${String(i + 1).padStart(2)}. ${s}   ← ${leg.from}  ${leg.km} km`);
  });
  L.push(`    返程/末段不计入（本脚本只算景点间串联）`);
  L.push('');
  L.push(`== 错峰可行性（阈值 ${gap} km，只看景区之间）==`);
  if (gapOk) L.push(`  ✅ 成立：相邻景区间隔都 ≤ ${gap} km`);
  else {
    L.push(`  ❌ 不成立：有 ${over.length} 段超过 ${gap} km ——`);
    over.forEach(l => L.push(`     ${l.from} → ${l.to}  ${l.km} km`));
    L.push(`  → 按 SKILL.md「行程方案规则」，此时**只给最快方案**，并说明原因。`);
  }
  process.stdout.write(L.join('\n') + '\n');
}
process.exit(0);
