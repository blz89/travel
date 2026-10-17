#!/usr/bin/env node
/**
 * spots_emit.js —— 景点页 data.json 骨架生成器（流程二步骤 10 用）
 *
 * 为什么要有它：景点页 JSON 的骨架（coverCards 统计、overview 表、url/urlLabel 三轨、
 * 门票三态、mine/source 占位）全是机械字段，手写既慢又容易漏；评审/门票口径已经由脚本算好。
 *
 * 用法:
 *   node scripts/spots_emit.js <selected.json> [--out data.json] [--title "<标题>"] [--note "<本次假设>"]
 *
 * selected.json（二选一形状）:
 *   [ {"name":"黄鹤楼","meta":"人文 · 2h · 08:30-17:00 · 距市区 2km · 热门","ticket":{"status":"paid"}} ]
 *   { "title":"武汉景点推荐", "spots":[ …同上… ] }
 *   · name / meta 必填（meta 里要有「热门」或「不热门」，脚本据此统计配比）
 *   · ticket 可选：paid / free / free_with_fee_parts（后者带 parts:["磨山","游船"]）
 *   · url / urlLabel 不用写：脚本按 data/spots-links.json 的评审结果自动填（A/B→介绍页，F→降级文案）
 *
 * 产出：可直接喂 make_html.js spots 的 data.json（mine / good / bad / source 留占位，等你补文案）。
 * 补完跑 make_html.js spots <data.json> <out.html> --check；数据门禁是 spots_check.js（B1–B8）。
 */
const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
if (!argv.length || argv.includes('--help') || argv.includes('-h')) {
  console.log(`spots_emit.js —— 景点页 data.json 骨架生成器

用法:
  node scripts/spots_emit.js <selected.json> [--out data.json] [--title "<标题>"] [--note "<本次假设>"]

selected.json:
  [ {"name":"黄鹤楼","meta":"人文 · 2h · 08:30-17:00 · 距市区 2km · 热门","ticket":{"status":"paid"}} ]
  或 { "title":"…", "spots":[ … ] }

说明:
  · name / meta 必填；meta 必须含「热门」或「不热门」（统计封面卡配比用）
  · ticket 可选：paid / free / free_with_fee_parts（后者带 parts）
  · url / urlLabel 自动按 data/spots-links.json 的评审结果填（A/B→介绍页；F/无记录→urlFallback 降级文案）
  · mine / good / bad / source 留「（待填）」占位——补完再跑 make_html.js spots --check
  · 没评审记录的景点会打印提醒：先跑 spot_link.js resolve --name "<景区>" --url <候选> --cache`);
  process.exit(0);
}
const opt = { out: '', title: '', note: '' };
const pos = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--out') opt.out = argv[++i];
  else if (a === '--title') opt.title = argv[++i];
  else if (a === '--note') opt.note = argv[++i];
  else pos.push(a);
}
const file = pos[0];
if (!file) { console.error('用法: node scripts/spots_emit.js <selected.json> [--out data.json]'); process.exit(2); }
let raw;
try { raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
catch (e) { console.error(`读取/解析失败: ${file}（${e.code || e.message}）`); process.exit(2); }
const list = Array.isArray(raw) ? raw : (raw && raw.spots) || [];
if (!list.length) { console.error('selected.json 里没有景点（顶层数组，或 {spots:[…]}）'); process.exit(2); }

const cacheFile = path.join(__dirname, '..', 'data', 'spots-links.json');
let cache = {};
try { cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8').replace(/^\uFEFF/, '')); } catch (_) { cache = {}; }

const noReview = [];
const spots = list.map((s) => {
  const name = String(s.name || '').trim();
  const meta = String(s.meta || '').trim();
  if (!name) { console.error('有一条景点缺 name'); process.exit(2); }
  if (!meta) { console.error(`「${name}」缺 meta（要含类型 · 时长 · 开放时间 · 距市区 · 热门/不热门）`); process.exit(2); }
  const e = cache[name];
  let url = '', urlLabel = '景区介绍', urlFallback;
  if (e && (e.grade === 'A' || e.grade === 'B') && e.intro) url = e.intro;
  else { urlLabel = '暂无官方介绍页'; urlFallback = '以景区公示为准'; if (!e) noReview.push(name); }
  if (url) { const { tierLabel } = require('./lib/host'); urlLabel = `景区介绍（${e.source || tierLabel(url)}）`; }
  const out = { name, meta, urlLabel, url, good: [], bad: [], mine: ['（待填：写 1～3 句你的判断 + 一个具体画面或取舍理由，合计 ≥24 字；可幽默，但不编事实、不写"景色优美历史悠久"这类空话）'], source: '来源：（待填：马蜂窝 / 大众点评 游客高频评价归纳）' };
  if (!url) out.urlFallback = urlFallback;
  if (s.ticket) out.ticket = s.ticket;
  return out;
});

const isHot = (m) => /热门/.test(m) && !/不热门/.test(m);
const hot = spots.filter((s) => isHot(s.meta));
const cold = spots.filter((s) => !isHot(s.meta));
const paid = spots.filter((s) => s.ticket && String(s.ticket.status || s.ticket) === 'paid').length;
const freeAll = spots.length - paid;
const names = (arr) => arr.map((x) => x.name).slice(0, 4).join(' / ') + (arr.length > 4 ? ` 等 ${arr.length} 个` : '');

const coverCards = [
  ['推荐景点', `${spots.length} 个`, `含 ${hot.length} 个热门、${cold.length} 个不热门`],
  ['热门景点', `${hot.length} 个`, names(hot) || '（待填）'],
  ['不热门景点', `${cold.length} 个`, names(cold) || '（待填）'],
];
if (paid || freeAll) coverCards.push(['门票', paid ? `${paid} 个需购票` : '全部免费', paid ? `其余 ${freeAll} 个免费或园中园另收费` : '园区不收大门票']);

const data = {
  coverTitle: opt.title || String(raw.title || '').trim() || '景点推荐',
  coverSubtitle: `${spots.length} 个精选 · 含 ${hot.length} 个热门 / ${cold.length} 个不热门`,
  coverCards,
  coverNote: opt.note || (raw && !Array.isArray(raw) && String(raw.note || '').trim()) || '（待填：本次假设，例如「按 10-19 到达、停留 2 天估算」）',
  overview: { colWidths: [3, 6, 2], rows: spots.map((s) => [s.name, s.meta, isHot(s.meta) ? '热门' : '不热门']) },
  spots,
};

const outFile = opt.out || path.join(path.dirname(path.resolve(file)), '景点数据.json');
fs.writeFileSync(outFile, JSON.stringify(data, null, 2), 'utf8');
console.log(`已写出 ${outFile}（${spots.length} 个景点：热门 ${hot.length} / 不热门 ${cold.length}；门票 ${paid} 个需购票）`);
if (noReview.length) console.log(`⚠ 这些景点没有网址评审记录，已按 F 级降级：${noReview.join('、')} —— 先跑 node scripts/spot_link.js resolve --name "<景区>" --url <候选1> --url <候选2> --cache`);
console.log('下一步：补 good / bad / mine / source 文案 → node scripts/make_html.js spots ' + path.basename(outFile) + ' <out.html> --check');
