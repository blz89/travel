#!/usr/bin/env node
'use strict';
// flow.js —— 提问框的唯一真源（正文只留状态名，问题文本从这里取）
// 用法：
//   node scripts/flow.js next --state <state> [--json]     # 取该状态的 ask_user_question 载荷
//   node scripts/flow.js --list                             # 列出所有状态
//   node scripts/flow.js --check                            # 自检：字段完整性 + 一框一问
// 纪律（与 SKILL.md「提问纪律」一致，脚本里强制）：每个载荷只问一件事、只有一个 header，
// 除「出行方式 / 方案来源 / 是·否」这类枚举外不给选项；问题文本不得包含两个以上的问号。

const STATES = {
  origin: {
    header: '出发地',
    question: '你从哪个城市出发？（写城市名就行，中英文都认，例如 Guangzhou / 广州）',
    next: ['dest'],
  },
  dest: {
    header: '目的地',
    question: '这次想去哪个城市？',
    next: ['mode'],
  },
  mode: {
    header: '出行方式',
    question: '这趟打算怎么走？',
    options: ['公共交通（火车/高铁/动车 + 飞机）', '自驾（自己开车）', '已在目的地'],
    next: ['plan_source', 'drive_ask', 'has_transport'],
  },
  plan_source: {
    header: '方案来源',
    question: '交通这块你希望我怎么给？',
    options: ['已有出行方案（我有车次/航班，按它排景点）', '由我提供方案'],
    next: ['date'],
  },
  date: {
    header: '出发日期',
    question: '哪天出发？（请填日期；说“明天/后天”也行，我会换算成具体日期并复述）',
    next: ['time', 'pax'],
  },
  time: {
    header: '出发时间',
    question: '大概几点出发？填“否”表示不介意出发时间。',
    next: ['pax'],
  },
  pax: {
    header: '出发人数',
    question: '几个人？请填两个数字：总人数在前、6~14 岁儿童数在后，用空格或任意符号隔开（只写一个数字＝全是成人）。例：2 / 2 1',
    next: [],
  },
  spots_pick: {
    header: '要不要排路线',
    question: '这些景点，需要我再排一份「景点之间的移动路线」吗？',
    options: ['是（给逐站行程）', '否（只交景点页）'],
    next: [],
  },
  drive_ask: {
    header: '要不要自驾路线',
    question: '是否需要进行自驾路线规划？节假日出行（尤其是高速免费通行时段）强烈推荐选「是」：会按近五年节假日同一时段的实际拥堵数据，规划一条避开大概率拥堵路段的路线；电车还会一并规划沿途充电点。',
    options: ['是', '否'],
    next: ['drive_when'],
  },
  drive_when: {
    header: '出发日期与时间',
    question: '计划哪天出发、几点走？（请填日期：哪一天 + 几点）',
    next: ['drive_car'],
  },
  drive_car: {
    header: '车辆类型',
    question: '车是电车还是油车？',
    options: ['电车', '油车'],
    next: ['drive_range'],
  },
  drive_range: {
    header: '充电间隔',
    question: '希望行驶多少公里后充电？填“否”＝默认 200 公里。',
    next: [],
  },
  has_transport: {
    header: '是否自驾到达',
    question: '这次是自驾到的目的地吗？（是＝景点间按自驾处理；否＝按公共交通+打车/步行处理）',
    options: ['是', '否'],
    next: [],
  },
};

function payload(state) {
  const d = STATES[state];
  if (!d) return null;
  const ask = { header: d.header, question: d.question };
  if (d.options) { ask.options = d.options.slice(); ask.multiSelect = false; }
  return { state, ask, next: d.next || [] };
}

// ── 语义判定（半下移）：判定要读客户意图，结论只有几种 → 脚本给判据 + 候选，模型只选一次 ──
const CRITERIA = {
  roundtrip: {
    question: '客户是不是在要求「往返 / 返程」？',
    cues: ['往返', '来回', '回程', '返程', '回去的票', '回来后', '…然后回'],
    verdicts: { roundtrip_yes: '客户要往返（或明确提到返程）', oneway: '只要单程（没提回程）' },
    action: '本技能不做往返规划：按单程走完，在交付语末尾加一句「返程按同一口径再跑一次」；不要自己拼往返票、不要为返程再问一轮参数。',
  },
  dissatisfied: {
    question: '客户对当前方案是「不满意」还是「选定」？',
    cues: ['太贵', '有点贵', '太慢', '太久', '换一个', '不要这个', '再便宜点', '还有别的吗', '不太行', '再快一点', '——（对比）就这个', '可以', '定了', '就它', '没问题'],
    verdicts: { want_new: '在要新方案', accept: '已选定当前方案', unclear: '看不出来——问一句「这个方案是否可行？」' },
    action: 'want_new：只改被点名的那一维（价格 / 时间 / 席别）重排，不要整页重生成；accept：记住选择，进入下一步。',
  },
  has_plan: {
    question: '客户是不是「已经有出行方案」？',
    cues: ['已买票', '买好了', '我订了', '我有方案', '自己开车', '我坐 G', '航班号', '——（只说了交通方式）高铁去 / 开车去'],
    verdicts: { has_plan: '已有方案（给了车次 / 航班号 / 已购票 / 自己开车）', no_plan: '只是说了交通方式，仍需规划' },
    action: 'has_plan：按 SKILL.md 口径跳过公共交通规划，直接问目的地 / 景点；no_plan：正常流程。',
  },
};

function criteriaPayload(id) {
  const d = CRITERIA[id];
  if (!d) return null;
  return { id, question: d.question, cues: d.cues.slice(), verdicts: d.verdicts, action: d.action };
}

function usage() {
  console.log(`flow.js —— 提问框的唯一真源（问题文本以本脚本为准，正文只写状态名）

用法：
  node scripts/flow.js next --state <state> [--json]
  node scripts/flow.js --list
  node scripts/flow.js --check
  node scripts/flow.js criteria --list                       # 三组「语义判定」的判据与候选结论
  node scripts/flow.js criteria --id <roundtrip|dissatisfied|has_plan> [--json]

状态（--list 也会打印）：
${Object.keys(STATES).map((k) => '  ' + k.padEnd(14) + STATES[k].header + ' → next: ' + ((STATES[k].next || []).join(', ') || '—')).join('\n')}

纪律：一次只弹一个框、一个 header、只问一件事；问题文本里出现两个以上问号会被 --check 拦下。
输出末行：FLOW state=<s> next=<n…>`);
}

function check() {
  const errs = [];
  for (const [k, d] of Object.entries(STATES)) {
    if (!d.header) errs.push(k + ': 缺 header');
    if (!d.question) errs.push(k + ': 缺 question');
    if (d.question && (d.question.match(/？/g) || []).length > 1) errs.push(k + ': 一个框里出现多个问句');
    if (d.options && d.options.length < 2) errs.push(k + ': 选项少于 2 个');
    if (d.header && d.header.length > 12) errs.push(k + ': header 超过 12 字（客户一眼扫不完）');
    for (const n of d.next || []) if (!STATES[n]) errs.push(k + ': next 指向不存在的状态 ' + n);
  }
  return errs;
}

function main() {
const argv = process.argv.slice(2);
const j = argv.includes('--json');
if (argv.includes('--help') || argv.includes('-h') || !argv.length) { usage(); process.exitCode = argv.length ? 0 : 2; }
if (argv.includes('criteria')) {
  if (argv.includes('--list')) {
    console.log('FLOW_CRITERIA ' + Object.keys(CRITERIA).join(','));
    for (const [k, d] of Object.entries(CRITERIA)) console.log(`  ${k.padEnd(13)} ${d.question}`);
    process.exitCode = 0;
    return;
  }
  const ci = argv.indexOf('--id');
  const id = ci >= 0 ? argv[ci + 1] : argv[argv.indexOf('criteria') + 1];
  const c = criteriaPayload(id);
  if (!c) { console.error('未知判定：' + id + '（用 criteria --list 看三组）'); process.exitCode = 2; return; }
  if (j) console.log(JSON.stringify(c, null, 2));
  else {
    console.log(`判定：${c.id}　${c.question}`);
    console.log('判据（命中任一即可，别自己发明）：');
    c.cues.forEach((x) => console.log('  · ' + x));
    console.log('候选结论：');
    for (const [k, v] of Object.entries(c.verdicts)) console.log(`  - ${k}：${v}`);
    console.log('处置：' + c.action);
    console.log(`CRITERIA id=${c.id} verdicts=${Object.keys(c.verdicts).join('|')}`);
  }
  process.exitCode = 0;
  return;
}
if (argv.includes('--list')) {
  console.log('FLOW_STATES ' + Object.keys(STATES).join(','));
  process.exitCode = 0;
  return;
}
if (argv.includes('--check')) {
  const errs = check();
  errs.forEach((e) => console.log('  ✗ ' + e));
  console.log(errs.length ? `FLOW_CHECK FAIL（${errs.length} 项）` : `FLOW_CHECK PASS（${Object.keys(STATES).length} 状态 / 一框一问）`);
  process.exitCode = errs.length ? 1 : 0;
  return;
}
const si = argv.indexOf('--state');
const st = si >= 0 ? argv[si + 1] : (argv[0] === 'next' ? argv[1] : argv[0]);
const p = payload(st);
if (!p) { console.error('未知状态：' + st + '（用 --list 看全部）'); process.exitCode = 2; return; }
if (j) {
  console.log(JSON.stringify(p, null, 2));
} else {
  console.log(`状态：${p.state}　标题：${p.ask.header}`);
  console.log('问题：' + p.ask.question);
  if (p.ask.options) p.ask.options.forEach((o, i) => console.log(`  ${i + 1}) ${o}`));
  console.log(`FLOW state=${p.state} next=${p.next.join(',') || '—'}`);
}
process.exitCode = 0;
}
main();
