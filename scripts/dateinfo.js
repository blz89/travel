#!/usr/bin/env node
/**
 * dateinfo.js —— 日期属性判定（法定节假日 / 调休上班 / 节假日及前后 N 天 / 星期）
 *
 * 用法:
 *   node scripts/dateinfo.js 2026-10-01 [--json]
 *   node scripts/dateinfo.js 2026-10-01 --window 1        # 窗口天数（前后各 N 天），默认 1
 *   node scripts/dateinfo.js --range 2026-09-28 2026-10-12
 *   node scripts/dateinfo.js --list 2026
 *
 * **判定逻辑只在 scripts/lib/holiday.js 一处实现**，本文件只是 CLI 外壳
 * （hours_check.js 也用同一个 lib 自动判节假日，不需要模型手工传 --holiday）。
 *
 * 输出（末行可机读）:
 *   DATEINFO date=2026-10-01 weekday=周四 holiday=yes window=yes name=国庆节 adjustWorkday=no dataYear=2026 certainty=official next=2026-10-08
 * 退出码: 0 = 正常；2 = 参数/数据错误
 */
const H = require('./lib/holiday');

function usage() {
  console.log([
    'dateinfo.js —— 日期属性判定（法定节假日 / 调休上班 / 节假日窗口 / 星期）',
    '',
    '用法:',
    '  node scripts/dateinfo.js <YYYY-MM-DD> [--window 1] [--json]',
    '  node scripts/dateinfo.js --range <YYYY-MM-DD> <YYYY-MM-DD> [--window 1] [--json]',
    '  node scripts/dateinfo.js --list <年>',
    '',
    '参数:',
    '  --window N   节假日窗口＝节假日本身 + 前后各 N 天（默认 1，即「节假日及前后各 1 天」）',
    '  --json       输出 JSON（逐日一条）',
    '  --list <年>  打印该年全部节假日与调休上班日',
    '',
    '口径（判定逻辑在 lib/holiday.js，唯一实现）:',
    '  holiday=yes      法定节假日当天（放假）',
    '  window=yes       节假日本身或窗口内（前后各 N 天）——自驾避堵、闭馆核查都看这个',
    '  adjustWorkday=yes 调休上班日（周末但要上班，避堵按工作日看待）',
    '  certainty=official  数据来自官方通知；low＝该年通知未发布，按固定公历日兜底（此时不要据此下避堵结论）',
    '',
    '退出码: 0 正常；2 参数/数据错误',
  ].join('\n'));
}

function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv[0] === '--help' || argv[0] === '-h') { usage(); return 0; }
  let windowN = 1, json = false, range = null, listYear = null;
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--window') windowN = parseInt(argv[++i], 10);
    else if (a === '--json') json = true;
    else if (a === '--range') { range = [argv[++i], argv[++i]]; }
    else if (a === '--list') listYear = argv[++i];
    else if (a.startsWith('-')) { console.error('未知参数：' + a); return 2; }
    else pos.push(a);
  }
  if (!Number.isFinite(windowN) || windowN < 0 || windowN > 7) { console.error('--window 必须是 0～7 的整数'); return 2; }

  if (listYear) {
    const r = H.listYear(listYear);
    if (!r.ok) { console.error('数据里没有 ' + listYear + ' 年（data/holidays-cn.json）'); return 2; }
    if (!r.published) console.log(`${listYear} 年放假安排尚未发布（${r.source}）；只有固定公历日兜底：` + r.fallback.map((f) => `${f.month}/${f.fromDay}-${f.toDay} ${f.name}`).join('、'));
    else {
      console.log(`${listYear} 年（${r.source}）`);
      for (const h of r.holidays) console.log(`  ${h.name}\t${h.from} → ${h.to}\t${H.span(h.from, h.to) + 1} 天`);
      if (r.workdays.length) console.log('  调休上班：' + r.workdays.join('、'));
    }
    return 0;
  }

  const dates = [];
  if (range) {
    const [a, b] = range;
    if (!H.parse(a) || !H.parse(b)) { console.error('--range 两个参数都要 YYYY-MM-DD'); return 2; }
    for (let d = H.parse(a); d <= H.parse(b); d = H.addDays(d, 1)) dates.push(H.ymd(d));
  } else if (pos.length) dates.push(pos[0]);
  else { console.error('缺少日期（例：2026-10-01）'); return 2; }

  const data = H.load();
  const rows = dates.map((s) => H.infoFor(s, windowN, data));
  if (json) { process.stdout.write(JSON.stringify(rows.length === 1 ? rows[0] : rows, null, 2) + '\n'); return 0; }
  if (rows.length > 1) {
    console.log('| 日期 | 星期 | 节假日 | 窗口内 | 名称 | 调休上班 | 确定性 |');
    console.log('|---|---|---|---|---|---|---|');
    for (const r of rows) console.log(`| ${r.date} | ${r.weekday} | ${r.holiday ? '是' : ''} | ${r.window ? '是' : ''} | ${r.name || ''} | ${r.adjustWorkday ? '是' : ''} | ${r.certainty} |`);
  }
  console.log(H.line(rows[rows.length - 1]));
  if (rows.some((r) => r.certainty === 'low')) console.log('⚠ 该年放假安排未发布：结论只能当「不确定」，需要精确避堵时先用 web_search 核一次官方通知。');
  return 0;
}

process.exitCode = main();
