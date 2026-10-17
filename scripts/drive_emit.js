#!/usr/bin/env node
/**
 * drive_emit.js —— 自驾讲解页 data.json 骨架生成器
 *
 * 为什么要有它：自驾页字段多且门禁严（地图章节 / 充电清单表头 / 避堵证据表必须含「依据」「预案」+「未发现被点名路段」行 /
 * 油车不许出现「充电」字样）。这些结构手写极易漏项，漏一项 make_html.js drive --check 就打回。
 *
 * 用法:
 *   node scripts/drive_emit.js <route.json> --image <路线图.png> [--vehicle 电车|油车] [--date YYYY-MM-DD]
 *                               [--out data.json] [--title "<标题>"]
 *   · route.json：{ "from":{"name":"杭州","lng":120.1551,"lat":30.2741},
 *                   "to":{"name":"上海","lng":121.4737,"lat":31.2304}, "vias":[] }
 *   · --image 必填且文件必须真实存在（先跑 map-shot.js shot 出图）；没有图就出不合法骨架，宁可当场报错
 *
 * 产出可直接喂 make_html.js drive；数值与文案留「（待填）」占位，补完跑 --check。
 */
const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
if (!argv.length || argv.includes('--help') || argv.includes('-h')) {
  console.log(`drive_emit.js —— 自驾讲解页 data.json 骨架生成器

用法:
  node scripts/drive_emit.js <route.json> --image <路线图.png> [--vehicle 电车|油车] [--date YYYY-MM-DD] [--out data.json] [--title "<标题>"]

route.json:
  { "from":{"name":"杭州","lng":120.1551,"lat":30.2741},
    "to":  {"name":"上海","lng":121.4737,"lat":31.2304}, "vias":[] }

说明:
  · --image 必填，文件必须存在（先 node scripts/map-shot.js shot "<链接>" 出图，链接用 map-shot.js link 生成）
  · --vehicle 默认电车：会生成充电清单表头 + 1 行占位；写「油车」则整段不出，并避免任何「充电」字样
  · 生成的结构：封面三卡 + 总览 + 路线图章节 + 〔充电清单〕+ 拥堵解读表（含"未发现被点名路段"行）+ 未获取项 + 来源
  · 补完跑：node scripts/make_html.js drive <data.json> <out.html> --check`);
  process.exit(0);
}
const opt = { image: '', vehicle: '电车', date: '', out: '', title: '' };
const pos = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--image') opt.image = argv[++i];
  else if (a === '--vehicle') opt.vehicle = argv[++i];
  else if (a === '--date') opt.date = argv[++i];
  else if (a === '--out') opt.out = argv[++i];
  else if (a === '--title') opt.title = argv[++i];
  else pos.push(a);
}
const file = pos[0];
if (!file) { console.error('用法: node scripts/drive_emit.js <route.json> --image <路线图.png>'); process.exit(2); }
let route;
try { route = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
catch (e) { console.error(`读取/解析失败: ${file}（${e.code || e.message}）`); process.exit(2); }
const from = route && route.from && route.from.name;
const to = route && route.to && route.to.name;
if (!from || !to) { console.error('route.json 需要 from.name 与 to.name'); process.exit(2); }
if (!opt.image) { console.error('缺 --image：先跑 map-shot.js link 生成链接、map-shot.js shot 截图，再把图路径传进来（讲解页必须内嵌真图）'); process.exit(2); }
if (!fs.existsSync(path.resolve(opt.image))) { console.error(`地图截图不存在: ${opt.image}`); process.exit(2); }

const isEV = !/油/.test(opt.vehicle);
const vias = Array.isArray(route.vias) ? route.vias : [];
const TBD = '（待填）';
const dateTxt = opt.date ? `${opt.date} 出发` : '（待填：出发日期与时间）';

const data = {
  vehicle: isEV ? '电车' : '油车',
  coverTitle: opt.title || `${from} → ${to} 自驾`,
  coverSubtitle: `${dateTxt} · ${isEV ? '电车（含充电规划）' : '油车'}`,
  coverCards: [
    ['总里程', TBD, '以图上为准'],
    ['纯驾驶时间', TBD, '不含休息'],
    [isEV ? '充电点' : '补能规划', isEV ? TBD : '不需要', isEV ? '按客户给的充电间隔' : '油车只算油费，不排补能点'],
    ['拥堵段', TBD, '节假日及前后 1 天才有'],
  ],
  coverNote: '（待填：本次假设，例如「按 10-01 出发、法定节假日口径估算」）',
  overview: {
    title: '总览',
    rows: [
      ['起终点', `${from} → ${to}`],
      ['途经点', vias.length ? `${vias.length} 个（按走廊取点）` : '留空＝地图默认最快线'],
      ['日期属性', dateTxt],
    ],
    colWidths: [2, 6],
  },
  sections: [
    {
      id: 'map', type: 'map', title: '路线总览', image: opt.image,
      caption: '底图与图上实线＝地图自己算路绘制；点、引线与名字＝本报告加的标注',
      credit: '© 高德地图',
      note: '（待填：一句话说明这条线为什么这么走）',
    },
  ],
};

if (isEV) {
  data.sections.push({
    id: 'charge', type: 'waypoints', title: '电车充电清单',
    colWidths: [2, 3, 2, 3, 3],
    note: '（待填：充电间隔与桩位实测情况）',
  });
  // 表头放在 waypoints 第一行（校验按「表头 + 至少 1 个充电点」数 d.waypoints 的行数）
  data.waypoints = [
    ['累计里程', '充电服务区', '本段里程', '桩（品牌 · 距服务区中心）', '备注'],
    [TBD, '（待填服务区名）', TBD, '（待填品牌 · 距离）', TBD],
  ];
  data.waypointsNote = '（待填：本段建议补电到的比例）';
}

data.sections.push({
  id: 'congestion', type: 'table', title: '拥堵解读',
  head: ['节点', '路段', '依据（年 · 节假日 · 发布单位）', '预案'],
  colWidths: [3, 3, 4, 4],
  rows: [
    [TBD, TBD, TBD, TBD],
    ['未发现被点名路段', '—', '未获取', '按导航实时路况走'],
  ],
  note: '（待填：说明本线在结论库里的命中情况）',
});

data.sections.push({
  id: 'notes', type: 'notes', title: '未获取项与出发当天复核清单',
  items: [
    '严重度：本页拥堵点按「命中次数 + 出发年是否被官方点名」分三档——深红 high（命中 ≥4 次或出发年被点名）/ 红 mid（命中 2–3 次或最新命中＝出发年-1）/ 浅红 low（其余）；地图上的深浅红点即这三档。',
    '未获取项：（待填：缺哪些数据、为什么缺）',
    '出发当天复核清单：按导航逐段看实时路况，堵到 X 分钟以上就走预案里的下道口',
  ],
});

data.sections.push({
  id: 'sources', type: 'sources', title: '来源',
  items: ['拥堵依据：data/high-congestion/segments.json（记录年份与发布单位）', '（待填：其它来源）'],
});

const outFile = opt.out || path.join(process.cwd(), '自驾数据.json');
fs.writeFileSync(outFile, JSON.stringify(data, null, 2), 'utf8');
console.log(`已写出 ${outFile}（${isEV ? '电车' : '油车'} · ${from} → ${to} · 章节 ${data.sections.length} 个${isEV ? ' · 含充电清单' : ' · 无充电清单'}）`);
console.log('下一步：补数值与文案 → node scripts/make_html.js drive ' + path.basename(outFile) + ' <out.html> --check');
