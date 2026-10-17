#!/usr/bin/env node
/**
 * gate.js —— 一次跑完「数据 → 页面 → 回复」三道门禁（省 3 次往返；没提 issue 的步骤不会漏跑）
 *
 * 用法:
 *   node scripts/gate.js spots <景点数据.json> <景点推荐.html> [--reply <回复.txt>]
 *   node scripts/gate.js itin  <行程数据.json> <行程方案.html> [--reply <回复.txt>]
 *   node scripts/gate.js plan  <交通数据.json> <交通方案.html> [--reply <回复.txt>]
 *   node scripts/gate.js drive <讲解页数据.json> <讲解页.html> [--reply <回复.txt>]
 *   node scripts/gate.js --help
 *
 * 它做什么（按顺序，前一步 FAIL 就停，别在坏数据上继续烧）:
 *   1) spots 专用：spots_check.js（B1–B8，含网址评审）
 *   2) make_html.js <kind> … --check（schema + 生成 + check_html 全套）
 *   3) --reply 给了才跑：reply_check.js（R1–R3）
 * 输出末行固定为 GATE_SUMMARY kind=… data=PASS|FAIL|SKIP html=… reply=… exit=N
 *
 * 退出码: 0 = 全 PASS；1 = 有 FAIL（照 FAIL 那行改，改完重跑同一条命令）。
 */
'use strict';
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const HELP = [
  'gate.js —— 一次跑完「数据 → 页面 → 回复」三道门禁',
  '',
  '用法:',
  '  node scripts/gate.js spots <景点数据.json> <景点推荐.html> [--reply <回复.txt>]',
  '  node scripts/gate.js itin  <行程数据.json> <行程方案.html> [--reply <回复.txt>]',
  '  node scripts/gate.js plan  <交通数据.json> <交通方案.html> [--reply <回复.txt>]',
  '  node scripts/gate.js drive <讲解页数据.json> <讲解页.html> [--reply <回复.txt>]',
  '',
  '顺序: spots_check（仅 spots）→ make_html <kind> … --check → reply_check（给了 --reply 才跑）',
  '末行: GATE_SUMMARY kind=… data=… html=… reply=… exit=N',
  '退出码: 0 = 全 PASS；1 = 有 FAIL。',
  '',
  '为什么要有它: 以前分三次跑（spots_check / make_html --check / reply_check），漏跑一次就是',
  '一次返工；而且每次都要自己把三个结论拼起来判断「到底能不能交」。',
].join('\n');

const KINDS = { plan: 'plan', spots: 'spots', itin: 'itin', drive: 'drive' };

function run(args) {
  const r = spawnSync(process.execPath, args, { encoding: 'utf8', cwd: __dirname });
  return { code: r.status == null ? 1 : r.status, out: (r.stdout || '') + (r.stderr || '') };
}

function failHint(out, code) {
  const lines = out.split('\n').map(l => l.trim()).filter(Boolean);
  const bad = lines.filter(l => /FAIL|错误|ERROR/.test(l) && !/0 FAIL/.test(l));
  return (bad.length ? bad[bad.length - 1] : lines[lines.length - 1] || `exit ${code}`).slice(0, 220);
}

const argv = process.argv.slice(2);
if (!argv.length || argv.includes('--help') || argv.includes('-h')) { process.stdout.write(HELP + '\n'); process.exit(argv.length ? 0 : 1); }

let kind = null, data = null, out = null, reply = null;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--reply') { reply = argv[++i]; continue; }
  if (!kind) { kind = a; continue; }
  if (!data) { data = a; continue; }
  if (!out) { out = a; continue; }
  console.error(`多余的参数: ${a}\n\n${HELP}`);
  process.exit(1);
}
if (!KINDS[kind]) { console.error(`未知页面类型: ${kind}（可选 ${Object.keys(KINDS).join(' / ')}）\n\n${HELP}`); process.exit(1); }
if (!data || !out) { console.error('缺少参数：需要 <data.json> <out.html>\n\n' + HELP); process.exit(1); }

// 子进程 cwd 固定为 scripts/，所以参数里的相对路径必须先按调用者的 cwd 解析成绝对路径
data = path.resolve(data);
out = path.resolve(out);
if (reply) reply = path.resolve(reply);

// 0) 入口先查输入：文件缺失/目录不存在要在 0ms 报，而不是先烧完 34s 浏览器校验
for (const [label, p] of [['data.json', data], ['out.html 的目标目录', path.dirname(out)], ['--reply 文件', reply]]) {
  if (!p) continue;
  if (!fs.existsSync(p)) { console.error(`[gate] 输入不存在：${label} = ${p}（先把它准备好，再跑本命令）`); process.exit(1); }
}

let dataState = 'SKIP', htmlState = 'SKIP', replyState = 'SKIP';
let failed = false;

// 1) 数据门禁（只有 spots 有独立数据门禁；plan/itin/drive 的 schema 校验在 make_html 里）
if (kind === 'spots') {
  const r = run([path.join(__dirname, 'spots_check.js'), data]);
  process.stdout.write(r.out);
  dataState = r.code === 0 ? 'PASS' : 'FAIL';
  if (r.code !== 0) { failed = true; console.error(`[gate] 数据门禁未过：${failHint(r.out, r.code)}`); }
}

// 2) 生成 + 页面门禁
if (!failed) {
  const r = run([path.join(__dirname, 'make_html.js'), kind, data, out, '--check']);
  process.stdout.write(r.out);
  htmlState = r.code === 0 ? 'PASS' : 'FAIL';
  if (r.code !== 0) {
    failed = true;
    // make_html 的数据校验失败会给出"数据校验/数据有问题"字样：那问题在 data.json，别让末行写成 data=SKIP
    if (/数据校验|数据有问题|数据不合规|schema/i.test(r.out)) dataState = 'FAIL';
    console.error(`[gate] 页面门禁未过：${failHint(r.out, r.code)}`);
  }
}

// 3) 回复门禁（可选）
if (!failed && reply) {
  const r = run([path.join(__dirname, 'reply_check.js'), reply]);
  process.stdout.write(r.out);
  replyState = r.code === 0 ? 'PASS' : 'FAIL';
  if (r.code !== 0) { failed = true; console.error(`[gate] 回复门禁未过：${failHint(r.out, r.code)}`); }
}

const exit = failed ? 1 : 0;
process.stdout.write(`\nGATE_SUMMARY kind=${kind} data=${dataState} html=${htmlState} reply=${replyState} exit=${exit}\n`);
if (!failed) process.stdout.write('全部门禁 PASS —— 这一版可以直接交付。\n');
else process.stdout.write('有门禁未过 —— 按上面 FAIL 那行改数据/回复，然后重跑这条命令。\n');
process.exitCode = exit;
