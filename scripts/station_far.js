#!/usr/bin/env node
'use strict';
/**
 * station_far.js —— 同城多站时，判断某个铁路车站是否「离市中心太远」
 *
 * 数据：data/stations-far.json（人工维护的远站名单，含大致 km 与接驳说明；阈值 thresholdKm 默认 15）
 * 口径：
 *   FAR     命中名单且 km ≥ 阈值 → 能换近站就换；不能换（无近站方案）才用，并在方案里写明接驳代价
 *   NEAR    命中名单但 km < 阈值（边缘站）→ 可用，不提示
 *   MAIN    命中「主站」后缀规则（与城市同名 / 东 / 北 / 中心之类常见主站）→ 直接可用
 *   UNKNOWN 不在名单、也不像主站 → 需要时查一次 web_search 核实接驳，再决定
 * 机场不做判断（机场普遍远离市区，按既有口径处理）。
 *
 * 用法：
 *   node scripts/station_far.js --check "南宁西"
 *   node scripts/station_far.js --check "南宁西,南宁东,南宁"
 *   node scripts/station_far.js --list
 *   node scripts/station_far.js --check "南宁西" --json
 */

const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, '..', 'data', 'stations-far.json');

function loadData() {
  const raw = fs.readFileSync(DATA, 'utf8').replace(/^\uFEFF/, '');
  const d = JSON.parse(raw);
  const threshold = Number.isFinite(d.thresholdKm) ? d.thresholdKm : 15;
  return { threshold, stations: d.stations || {} };
}

/** 看起来像主站的：城市名本身、城市+东/北（常见主站朝向）、或已知主站形态 */
function looksMain(name) {
  const n = String(name || '').trim();
  if (!n) return false;
  if (/(东|北)$/.test(n)) return true; // 东站/北站多为城市主站或近城站（如上海虹桥、北京南属例外但不在判断范围）
  if (!/(西|南)$/.test(n)) return true; // 不带方位的站名（如「上海」「桂林」）基本是主站
  return false;
}

function check(name, data) {
  const n = String(name || '').trim();
  const hit = data.stations[n];
  if (hit) {
    const km = Number(hit.km);
    if (Number.isFinite(km) && km < data.threshold) {
      return { station: n, verdict: 'NEAR', km, city: hit.city || '', note: hit.note || '', threshold: data.threshold };
    }
    return { station: n, verdict: 'FAR', km: Number.isFinite(km) ? km : null, city: hit.city || '', note: hit.note || '', threshold: data.threshold };
  }
  if (looksMain(n)) return { station: n, verdict: 'MAIN', km: null, city: '', note: '', threshold: data.threshold };
  return { station: n, verdict: 'UNKNOWN', km: null, city: '', note: '未收录，且带「西/南」方位——需要时查一次 web_search 核实到市中心/首个景点的接驳', threshold: data.threshold };
}

function usage() {
  console.log([
    'station_far.js —— 判断铁路车站是否离市中心太远（同城多站时优先近站）',
    '',
    '用法：',
    '  node scripts/station_far.js --check "南宁西"              # 单个站',
    '  node scripts/station_far.js --check "南宁西,南宁东,南宁"   # 多个站，逗号分隔',
    '  node scripts/station_far.js --check "南宁西" --json       # JSON 输出',
    '  node scripts/station_far.js --list                        # 列出名单（城市 / 站名 / km / 说明）',
    '',
    '结论：',
    '  FAR     离市中心太远（≥ 阈值）→ 有近站方案就换；只能用它时在方案里写明接驳代价',
    '  NEAR    边缘站（< 阈值）→ 可用',
    '  MAIN    主站形态（与城市同名 / 东 / 北）→ 可用',
    '  UNKNOWN 未收录且带「西/南」→ 需要时查一次核实',
    '',
    '机场不做判断（机场普遍远离市区）。',
  ].join('\n'));
}

function main(argv) {
  const args = argv.slice(2);
  if (!args.length || args[0] === '--help' || args[0] === '-h') { usage(); return 0; }
  let data;
  try { data = loadData(); } catch (e) { console.error(`读不到/解析不了数据文件：${e.message}`); return 2; }

  if (args[0] === '--list') {
    const rows = Object.entries(data.stations)
      .map(([k, v]) => ({ 城市: v.city || '', 车站: k, km: v.km, 说明: v.note || '' }))
      .sort((a, b) => String(a.城市).localeCompare(String(b.城市), 'zh'));
    for (const k of Object.keys(rows[0] || {})) void k;
    const w = (s, n) => { let x = 0; for (const ch of String(s)) x += /[\u4e00-\u9fff]/.test(ch) ? 2 : 1; return String(s) + ' '.repeat(Math.max(0, n - x)); };
    console.log(w('城市', 10) + w('车站', 12) + w('km(约)', 8) + '说明');
    for (const r of rows) console.log(w(r.城市, 10) + w(r.车站, 12) + w(r.km, 8) + r.说明);
    console.log(`\n阈值：${data.threshold} km（km 为直线距离粗略值，仅供初筛）`);
    return 0;
  }

  let targets = null;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--check') targets = args[++i];
    else if (args[i] === '--json') json = true;
    else { console.error(`未知参数：${args[i]}（看 --help）`); return 2; }
  }
  if (!targets) { console.error('缺少 --check（例：--check "南宁西"）'); return 2; }

  const names = targets.split(/[,，、\s]+/).map((s) => s.trim()).filter(Boolean);
  if (!names.length) { console.error('--check 后面要给至少一个站名（逗号分隔），例：--check "南宁西,南宁东"'); return 2; }
  const results = names.map((n) => check(n, data));

  if (json) { console.log(JSON.stringify({ threshold: data.threshold, results }, null, 2)); return 0; }

  const label = { FAR: '偏远', NEAR: '边缘可', MAIN: '主站', UNKNOWN: '未收录' };
  const w = (s, n) => { let x = 0; for (const ch of String(s)) x += /[\u4e00-\u9fff]/.test(ch) ? 2 : 1; return String(s) + ' '.repeat(Math.max(0, n - x)); };
  console.log(w('车站', 14) + w('结论', 10) + w('km(约)', 8) + '说明');
  for (const r of results) {
    console.log(w(r.station, 14) + w(label[r.verdict], 10) + w(r.km === null ? '—' : r.km, 8) + (r.note || ''));
  }
  const far = results.filter((r) => r.verdict === 'FAR');
  const unknown = results.filter((r) => r.verdict === 'UNKNOWN');
  if (far.length) console.log(`\nSTATION_ACTION 偏远站：${far.map((r) => `${r.station}（距市中心约 ${r.km === null ? '?' : r.km} km，${r.city || ''}）`).join(' / ')} —— 同城有近站方案就换；只能用它时在方案里写明接驳代价`);
  if (unknown.length) console.log(`STATION_ACTION 待核实：${unknown.map((r) => r.station).join(' / ')} —— 需要时查一次 web_search（≤1 次）`);
  return 0;
}

process.exitCode = main(process.argv);
