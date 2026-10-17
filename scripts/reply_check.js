#!/usr/bin/env node
/**
 * reply_check.js —— 聊天回复门禁（回复本身也要过闸）
 *
 * 为什么需要它：回复是**唯一没有走门禁的产出**。页面有 `check_html.js`、数据有 `make_html.js` 的
 * `validateData`，而聊天回复直到发出去都没人检查——写啰嗦了、把数据源写进去了都不拦。
 *
 * 用法:
 *   node scripts/reply_check.js <回复文本文件>
 *
 * 退出码: 0 = PASS；1 = FAIL
 *
 * 检查:
 *   R1 行数 ≤ 20（只数非空行）——回复应当"三句话讲结论 + 一张每方案一行的价目表"
 *   R2 不得出现内部技术 / 数据源用语（同 check_html.js 的 A7 口径）
 *   R3 不得整段复述页面内容（**WARN，不算 FAIL**）——启发式：车次/航班号 ≥3 个且时刻 ≥3 个
 *
 * 注意: 不要读本脚本源码——用 --help 就够了。
 */
'use strict';

const fs = require('node:fs');

const MAX_LINES = 20;

const HELP = [
  'reply_check.js —— 聊天回复门禁（写完回复、发出去之前跑）',
  '',
  '用法:',
  '  node scripts/reply_check.js <回复文本文件>',
  '',
  '退出码: 0 = PASS；1 = FAIL（R3 只是 WARN，不影响退出码）。',
  '',
  '检查项:',
  `  R1 行数 ≤ ${MAX_LINES}（只数非空行）`,
  '  R2 不出现内部技术 / 数据源用语（12306 / OpenFlights / web_search / 脚本名 / 未渲染标记）',
  '  R3 未整段复述页面内容（启发式，仅 WARN）',
  '',
  '注意: 不要读本脚本源码——用 --help 就够了。',
].join('\n');

function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--help' || args[0] === '-h') { console.log(HELP); process.exit(0); }
  const file = args[0];
  if (!file) { console.error('用法: node scripts/reply_check.js <回复文本文件>（--help 看完整说明）'); process.exit(1); }
  if (!fs.existsSync(file)) { console.error(`文件不存在: ${file}`); process.exit(1); }

  const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  const lines = text.split(/\r?\n/).filter(l => l.trim() !== '');
  const fail = [], warn = [], pass = [];

  // R1 行数
  if (lines.length <= MAX_LINES) pass.push(`R1 行数 ${lines.length} ≤ ${MAX_LINES}`);
  else fail.push(`R1 回复 ${lines.length} 行，超过 ${MAX_LINES} 行 —— 只保留「三句话讲结论 + 一张每方案一行的价目表」，其余改成"详见页面"`);

  // R2 技术 / 数据源用语（与 check_html.js A7 同口径）
  const TECH = (() => {
    const t = [];
    t.push(...(text.match(/12306/g) || []));
    t.push(...(text.match(/OpenFlights/gi) || []));
    t.push(...(text.match(/web_search/gi) || []));
    t.push(...(text.match(/\b(?:12306|flight|plan|itinerary|make_html|check_html|spots_check|spots_baseline|reply_check|map-shot|congestion-nodes|traffic-history)\.js\b/gi) || []));
    t.push(...(text.match(/\{\{[^}]{0,40}\}\}/g) || []));
    return [...new Set(t)];
  })();
  // 例外：「数据来源只写在聊天回复里」——回复里**允许**写 12306 作为数据来源说明。
  // 因此这里只把「脚本名 / 接口名 / 未渲染标记」判 FAIL；数据源名单独作为 WARN 提示。
  const INTERNAL = TECH.filter(x => /\.js$|^\{\{/.test(x));
  const SOURCE_NAMES = TECH.filter(x => !INTERNAL.includes(x));
  if (!INTERNAL.length) pass.push('R2 未出现脚本名 / 未渲染标记');
  else fail.push(`R2 回复出现内部用语：${INTERNAL.join(' / ')} —— 客户不需要知道实现细节`);
  if (SOURCE_NAMES.length) warn.push(`R2' 回复提到数据源（${SOURCE_NAMES.join(' / ')}）——这是允许的（数据来源就写在回复里），仅提示确认不是误写`);

  // R3 是否整段复述页面（启发式，仅 WARN）
  const trainCodes = new Set((text.match(/\b[GDCZTK]\d{1,4}\b/g) || []));
  const flightCodes = new Set((text.match(/\b[A-Z]{2}\d{3,4}\b/g) || []));
  const times = new Set((text.match(/\b\d{1,2}:\d{2}\b/g) || []));
  const codes = trainCodes.size + flightCodes.size;
  if (codes >= 3 && times.size >= 3) {
    warn.push(`R3 回复里出现 ${codes} 个班次号与 ${times.size} 个时刻，疑似整段复述页面内容 —— 页面上能看到的，回复里一句带过即可`);
  } else {
    pass.push(`R3 未整段复述页面（班次号 ${codes} 个 / 时刻 ${times.size} 个）`);
  }

  const total = pass.length + warn.length + fail.length;
  console.log(`reply_check: ${pass.length} PASS / ${warn.length} WARN / ${fail.length} FAIL（共 ${total} 项）`);
  pass.forEach(p => console.log(`  PASS ${p}`));
  warn.forEach(w => console.log(`  WARN ${w}`));
  fail.forEach(f => console.log(`  FAIL ${f}`));
  if (fail.length) console.log('\n→ 改完重跑，必须 exit 0 再发出。');
  process.exit(fail.length ? 1 : 0);
}

if (require.main === module) main();

module.exports = { main };
