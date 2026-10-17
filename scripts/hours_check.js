#!/usr/bin/env node
'use strict';
/**
 * hours_check.js —— 游玩期内的「闭馆 / 闭园 / 来不及」机器核查（出发前计划用，不查实时）
 *
 * 输入：景点数据（与 make_html.js spots 的 data 同形，只读 spots[].name / meta）
 * 输出：每个景点在「到达时刻 + 停留天数」窗口内是否可游，以及可游的第一天
 *
 * 用法：
 *   node scripts/hours_check.js <spots.json> --arrive 2026-10-19T17:40 [--days 2] [--buffer 60] [--json]
 *   （自驾分支：--arrive <出发日>T<出发时刻> --buffer 180，用出发时间推当天可游时间）
 *
 * 结论口径：
 *   open    到达当天就能排
 *   tight   到达当天能排，但入场余量 < 60 分钟（页面备注「直奔，来不及改次日」）
 *   shift   当天闭馆/来不及 → 改到「可游日」列出的那天
 *   closed  游玩期内全部闭馆 → 必须从推荐里剔除，换备选景点
 *   unknown 景区只写「以景区公示为准」→ 按可游处理，页面注明现场确认
 */

const fs = require('fs');
const path = require('path');
const H = require('./lib/holiday'); // 节假日判定的唯一实现（与 dateinfo.js 共用）

const WEEK = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 };
const DAY_NAME = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function pad(n) { return String(n).padStart(2, '0'); }
function ymd(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function addDays(d, n) { const x = new Date(d.getTime()); x.setDate(x.getDate() + n); return x; }
function parseHM(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s).trim());
  if (!m) return null;
  const h = +m[1], mi = +m[2];
  if (h > 24 || mi > 59) return null;
  return h * 60 + mi;
}
function fmtHM(min) {
  if (min >= 24 * 60) return '24:00';
  return `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;
}

/** 解析 meta 里的闭馆日：周一 / 每周一 / 周一、周二 / 周一至周三 / 法定节假日除外 */
function parseCloseDays(meta) {
  const t = String(meta || '');
  const days = new Set();
  let holidayWaiver = /法定节假日(除外|正常开放|开放)/.test(t);
  // 「周一至周三闭馆」这类区间
  const rangeRe = /(?:每)?(?:周|星期|礼拜)([一二三四五六日天])\s*(?:至|到|-|—|~)\s*(?:周|星期|礼拜)?([一二三四五六日天])/g;
  let m;
  while ((m = rangeRe.exec(t))) {
    let a = WEEK[m[1]], b = WEEK[m[2]];
    if (a === undefined || b === undefined) continue;
    // 必须与「闭」同句，避免「周一至周五开放」误判
    const around = t.slice(Math.max(0, m.index - 6), m.index + m[0].length + 8);
    if (!/闭|休|停止|不开放|停馆|停业/.test(around)) continue;
    let cur = a, guard = 0;
    while (guard++ < 8) { days.add(cur); if (cur === b) break; cur = (cur + 1) % 7; }
  }
  // 单个「周一闭馆 / 每周二休」
  const oneRe = /(?:每)?(?:周|星期|礼拜)([一二三四五六日天])/g;
  while ((m = oneRe.exec(t))) {
    const idx = m.index + m[0].length;
    const tail = t.slice(idx, idx + 12);
    if (/^\s*(?:至|到|-|—|~)/.test(tail)) continue; // 区间已处理
    if (!/闭|休|停止|不开放|停馆|停业/.test(tail)) continue;
    const d = WEEK[m[1]];
    if (d !== undefined) days.add(d);
  }
  return { closeDays: days, holidayWaiver };
}

/** 解析季节性闭园：11月-次年3月 / 冬季（12、1、2 月）/ 12月1日-3月31日 */
function parseClosedMonths(meta) {
  const t = String(meta || '');
  const months = new Set();
  const re = /(\d{1,2})月\s*(?:\d{1,2}日?)?\s*(?:[-–—~至]|到)\s*(?:次年)?\s*(\d{1,2})月/g;
  let m;
  let hit = false;
  while ((m = re.exec(t))) {
    const around = t.slice(Math.max(0, m.index - 8), m.index + m[0].length + 10);
    if (!/闭|封|关|停|不开放|停运/.test(around)) continue;
    hit = true;
    let a = +m[1], b = +m[2];
    if (a < 1 || a > 12 || b < 1 || b > 12) continue;
    let cur = a, guard = 0;
    while (guard++ < 13) { months.add(cur); if (cur === b) break; cur = cur === 12 ? 1 : cur + 1; }
  }
  if (!hit && /冬季.{0,6}(闭|封|关|停|不开放|停运)/.test(t)) { months.add(12); months.add(1); months.add(2); }
  if (!hit && /旺季|淡季/.test(t) && /冬季.{0,6}(闭|封|关|停)/.test(t)) { months.add(12); months.add(1); months.add(2); }
  return months;
}

/** 解析开放窗口与停止入场 */
function parseWindow(meta) {
  const t = String(meta || '');
  const unknown = /以景区公示为准/.test(t);
  const hmRe = /(\d{1,2}:\d{2})\s*[-–—~至]\s*(\d{1,2}:\d{2})/g;
  let m, open = null, close = null;
  while ((m = hmRe.exec(t))) {
    const a = parseHM(m[1]), b = parseHM(m[2]);
    if (a === null || b === null) continue;
    open = a; close = b; break;
  }
  if (open === null && /全天|24\s*小时|00:00\s*[-–—~至]\s*24:00/.test(t)) { open = 0; close = 24 * 60; }
  if (close !== null && close === 0) close = 24 * 60;
  const le = /(\d{1,2}:\d{2})\s*停止(?:入馆|入场|入园|售检票|售票|入场券)/.exec(t);
  const lastEntry = le ? parseHM(le[1]) : null;
  return { open, close, lastEntry, unknown };
}

function checkOne(spot, ctx) {
  const meta = spot.meta || '';
  const { closeDays, holidayWaiver } = parseCloseDays(meta);
  // 节假日：默认**自动判**（lib/holiday.js 是唯一实现）；--holiday / --no-holiday 可强制覆盖
  const holFor = (d) => (ctx.holiday === null ? H.isWindow(ymd(d)) : ctx.holiday);
  const closedMonths = parseClosedMonths(meta);
  const win = parseWindow(meta);
  const notes = [];
  if (closeDays.size) notes.push([...closeDays].sort().map((d) => DAY_NAME[d]).join('/') + '闭馆');
  if (closedMonths.size) notes.push([...closedMonths].sort((x, y) => x - y).join('/') + ' 月闭园');
  if (win.unknown) notes.push('以景区公示为准');

  // 可游日窗口
  const days = [];
  for (let i = 0; i < ctx.days; i++) days.push(addDays(ctx.arriveDate, i));

  const openDates = [];
  for (const d of days) {
    const holidayOpen = holFor(d) && holidayWaiver; // 「法定节假日除外」的闭馆日，节假日期间照常开放
    if (!holidayOpen && closedMonths.has(d.getMonth() + 1)) continue;
    if (!holidayOpen && closeDays.has(d.getDay())) continue;
    openDates.push(d);
  }

  if (!openDates.length) {
    return { name: spot.name, verdict: 'closed', firstDate: null, window: win, notes };
  }

  const firstDate = openDates[0];
  const sameDay = ymd(firstDate) === ymd(ctx.arriveDate);
  if (!sameDay) {
    return { name: spot.name, verdict: 'shift', firstDate, window: win, notes };
  }

  // 到达当天：算入场余量
  if (ctx.arriveMin === null) {
    return { name: spot.name, verdict: 'open', firstDate, window: win, notes };
  }
  if (win.close === null) {
    return { name: spot.name, verdict: win.unknown ? 'unknown' : 'open', firstDate, window: win, notes };
  }
  const readyAt = ctx.arriveMin + ctx.buffer;
  const effOpen = win.open === null ? 0 : win.open;
  const effLast = win.lastEntry !== null ? win.lastEntry : win.close - 60;
  if (readyAt >= win.close) {
    // 当天进不去 → 顺延到下一个可游日
    const next = openDates.find((d) => ymd(d) !== ymd(ctx.arriveDate));
    return { name: spot.name, verdict: next ? 'shift' : 'closed', firstDate: next || null, window: win, notes };
  }
  if (readyAt < effOpen) {
    notes.push(`到达早于开园，可先放行李/吃早饭，${fmtHM(effOpen)} 再进`);
  }
  if (readyAt > effLast) {
    return { name: spot.name, verdict: 'tight', firstDate, window: win, notes };
  }
  const arrHol = holFor(firstDate);
  if (holidayWaiver && closeDays.size) notes.push('法定节假日除外');
  if (arrHol && holidayWaiver) notes.push('本次落在法定节假日 → 标了「法定节假日除外」的闭馆日按开放处理');
  else if (arrHol) notes.push('本次落在法定节假日：开放时间 / 闭馆可能调整，以景区当日公告为准');
  return { name: spot.name, verdict: win.unknown ? 'unknown' : 'open', firstDate, window: win, notes };
}

function usage() {
  const lines = [
    'hours_check.js —— 游玩期闭馆 / 闭园 / 入场时间核查（出发前计划用）',
    '',
    '用法：',
    '  node scripts/hours_check.js <spots.json> --arrive 2026-10-19T17:40 [--days 2] [--buffer 60] [--json]',
    '',
    '参数：',
    '  <spots.json>   景点数据（与 make_html.js spots 的 data 同形；只读 spots[].name / meta）',
    '  --arrive       到达时刻：公共交通 = 所选方案到达站/落地机场的时刻；自驾 = 出发的时刻',
    '                 （只给日期也行：--arrive 2026-10-19，按「当天全天可游」判）',
    '  --days         游玩天数（含到达当天），默认 2',
    '  --buffer       到达后到景区的耗时（分钟），默认 60；自驾建议 180',
    '  --holiday      强制按「节假日期间」处理（默认不用传：脚本逐日调 lib/holiday.js 自动判）',
  '  --no-holiday   强制按「非节假日」处理（仅判不准时手动覆盖）',
    '                 带上后：meta 标「法定节假日除外」的闭馆日按开放处理，并提示节假日开放时间可能调整',
    '  --json         输出 JSON（字段见 --help 末尾）',
    '',
    '结论口径：',
    '  open    到达当天可排',
    '  tight   当天可排但入场余量 < 60 分钟（页面备注「直奔，来不及改次日」）',
    '  shift   当天闭馆或来不及 → 改到「可游日」那天',
    '  closed  游玩期内全闭 → 必须剔除，补一个备选景点',
    '  unknown 只写「以景区公示为准」→ 按可排处理，页面注明现场确认',
    '',
    '识别规则（meta 里写就认）：周一闭馆 / 每周二休 / 周一、周二闭馆 / 周一至周三闭馆 /',
    '  法定节假日除外 / 11月-次年3月闭园 / 冬季闭园 / 08:30-17:00 / 全天 / 16:00停止入馆',
    '',
    '退出码：0 = 有可排景点（closed 需按提示剔除）；1 = 全部不可排；2 = 参数/文件错误',
  ];
  console.log(lines.join('\n'));
}

function main(argv) {
  const args = argv.slice(2);
  if (!args.length || args[0] === '--help' || args[0] === '-h') { usage(); return 0; }
  const file = args[0];
  const opt = { arrive: null, days: 2, buffer: 60, json: false, holiday: null }; // null = 自动判（lib/holiday.js）
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === '--arrive') opt.arrive = args[++i];
    else if (a === '--days') opt.days = parseInt(args[++i], 10);
    else if (a === '--buffer') opt.buffer = parseInt(args[++i], 10);
    else if (a === '--json') opt.json = true;
    else if (a === '--holiday') opt.holiday = true;
  else if (a === '--no-holiday') opt.holiday = false;
    else { console.error(`未知参数：${a}`); return 2; }
  }
  if (!opt.arrive) { console.error('缺少 --arrive（例：--arrive 2026-10-19T17:40）'); return 2; }
  if (!Number.isFinite(opt.days) || opt.days < 1 || opt.days > 15) { console.error('--days 必须是 1～15 的整数'); return 2; }
  if (!Number.isFinite(opt.buffer) || opt.buffer < 0 || opt.buffer > 720) { console.error('--buffer 必须是 0～720 的整数（分钟）'); return 2; }

  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2}))?$/.exec(opt.arrive.trim());
  if (!m) { console.error('--arrive 格式应为 YYYY-MM-DD 或 YYYY-MM-DDTHH:mm'); return 2; }
  const arriveDate = new Date(+m[1], +m[2] - 1, +m[3]);
  if (Number.isNaN(arriveDate.getTime())) { console.error('--arrive 日期非法'); return 2; }
  const arriveMin = m[4] !== undefined ? (+m[4]) * 60 + (+m[5]) : null;

  let raw;
  try { raw = fs.readFileSync(path.resolve(file), 'utf8'); } catch (e) { console.error(`读不到文件：${file}`); return 2; }
  let data;
  try { data = JSON.parse(raw.replace(/^\uFEFF/, '')); } catch (e) { console.error(`JSON 解析失败：${e.message}`); return 2; }
  const spots = Array.isArray(data) ? data : data.spots;
  if (!Array.isArray(spots) || !spots.length) { console.error('数据里没有 spots[]（或为空）'); return 2; }

  const ctx = { arriveDate, arriveMin, days: opt.days, buffer: opt.buffer, holiday: opt.holiday };
  const results = spots.map((s) => checkOne({ name: s.name || '(未命名)', meta: s.meta || '' }, ctx));
  const order = { closed: 0, shift: 1, tight: 2, unknown: 3, open: 4 };
  results.sort((a, b) => (order[a.verdict] - order[b.verdict]) || String(a.name).localeCompare(String(b.name), 'zh'));

  if (opt.json) {
    console.log(JSON.stringify({
      arrive: opt.arrive, days: opt.days, buffer: opt.buffer,
      spots: results.map((r) => ({
        name: r.name, verdict: r.verdict, firstDate: r.firstDate ? ymd(r.firstDate) : null,
        open: r.window.open === null ? null : fmtHM(r.window.open),
        close: r.window.close === null ? null : fmtHM(r.window.close),
        lastEntry: r.window.lastEntry === null ? null : fmtHM(r.window.lastEntry),
        notes: r.notes,
      })),
    }, null, 2));
    return 0;
  }

  const label = { open: '可排', tight: '可排·紧', shift: '改日', closed: '剔除', unknown: '存疑' };
  console.log(`HOURS ${opt.arrive} + ${opt.days} 天 · 缓冲 ${opt.buffer} 分钟`);
  console.log('');
  const rows = results.map((r) => {
    const w = r.window.open === null ? (r.window.unknown ? '以公示为准' : '?') : `${fmtHM(r.window.open)}-${fmtHM(r.window.close)}`;
    return { 景点: r.name, 结论: label[r.verdict], 可游日: r.firstDate ? ymd(r.firstDate) : '—', 开放时间: w, 备注: r.notes.join('；') || '' };
  });
  for (const k of Object.keys(rows[0] || {})) void k;
  const width = (s, n) => { let w = 0; for (const ch of s) w += /[\u4e00-\u9fff]/.test(ch) ? 2 : 1; return s + ' '.repeat(Math.max(0, n - w)); };
  console.log(width('景点', 22) + width('结论', 10) + width('可游日', 13) + width('开放时间', 15) + '备注');
  for (const r of rows) {
    console.log(width(r.景点, 22) + width(r.结论, 10) + width(r.可游日, 13) + width(r.开放时间, 15) + r.备注);
  }

  const counts = {};
  for (const r of results) counts[r.verdict] = (counts[r.verdict] || 0) + 1;
  console.log('');
  console.log(`HOURS_SUMMARY open=${counts.open || 0} tight=${counts.tight || 0} shift=${counts.shift || 0} closed=${counts.closed || 0} unknown=${counts.unknown || 0}`);

  const closed = results.filter((r) => r.verdict === 'closed');
  if (closed.length) console.log(`HOURS_ACTION 剔除并换备选：${closed.map((r) => r.name + '（' + (r.notes.join('；') || '游玩期内闭馆') + '）').join(' / ')}`);
  const shift = results.filter((r) => r.verdict === 'shift');
  if (shift.length) console.log(`HOURS_ACTION 改日：${shift.map((r) => `${r.name}→${ymd(r.firstDate)}`).join(' / ')}`);

  const usable = results.filter((r) => r.verdict !== 'closed').length;
  return usable ? 0 : 1;
}

process.exitCode = main(process.argv);
