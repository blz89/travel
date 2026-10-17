#!/usr/bin/env node
/**
 * spots_baseline.js —— 景点「基线」离线查询（ChinaTravel-Sandbox · CC BY 4.0）
 *
 * 作用：为景点预研提供**开放时间 / 门票 / 建议游览时长**的离线基线，
 *       免去「每个景点查一次开放时间」的重复检索（那是景点预研里最贵的一环）。
 *
 * 用法:
 *   node scripts/spots_baseline.js cities                 # 列出有基线的 10 个城市
 *   node scripts/spots_baseline.js <城市> [--limit N]    # 列出该城景点基线（默认 40 条）
 *   node scripts/spots_baseline.js <城市> --search <词>  # 按名称过滤
 *   node scripts/spots_baseline.js <城市> --json         # 输出 JSON（给脚本用）
 *
 * 退出码: 0 = 命中（在 10 城内）；2 = 未覆盖（CHINATRAVEL=0，退回 web_search）；1 = 用法错误
 *
 * ⚠ 使用边界（务必遵守）:
 *   · 开放时间是**常规时段口径**，旺季 / 节假日会调整 —— **仍须按技能规则以景区官网公告核对**；
 *     本基线只用来**免去重复检索**，不是最终依据。
 *   · 本数据集同批的 flights / trains 表**已知有错**（合成航班号、时刻票价与 12306 不符），
 *     **本脚本只读 attractions 表**，绝不供时刻与票价使用。
 *   · 数据许可 CC BY 4.0，交付物**不得**把本数据当自己的；页面上不出现来源信息（数据来源只写聊天回复）。
 *
 * 注意: 不要读本脚本源码——用 --help 就够了。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DATA = path.join(__dirname, '..', 'data', 'china-travel', 'attractions.json');
const CITIES = ['北京', '成都', '重庆', '广州', '杭州', '南京', '上海', '深圳', '苏州', '武汉'];

const HELP = [
  'spots_baseline.js —— 景点基线离线查询（开放时间 / 门票 / 建议时长）',
  '',
  '用法:',
  '  node scripts/spots_baseline.js cities                  # 列出有基线的城市',
  '  node scripts/spots_baseline.js <城市> [--limit N]      # 列出该城景点基线（默认 40 条）',
  '  node scripts/spots_baseline.js <城市> --search <词>    # 按名称过滤',
  '  node scripts/spots_baseline.js <城市> --json           # 输出 JSON',
  '',
  '退出码: 0 = 命中；2 = 该城市无基线（CHINATRAVEL=0，退回 web_search）；1 = 用法错误',
  '',
  '边界: 开放时间为常规时段口径，旺季/节假日会调整 —— 仍须按技能规则以景区官网公告核对。',
  '数据: LAMDA-NeSy/ChinaTravel-Sandbox · CC BY 4.0（署名见 data/china-travel/README.md）',
  '',
  '注意: 不要读本脚本源码——用 --help 就够了。',
].join('\n');

function load() {
  try {
    // 数据文件 ~560KB；只在真正查询时读一次，不常驻
    return JSON.parse(fs.readFileSync(DATA, 'utf8'));
  } catch (e) {
    return null;
  }
}

function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv[0] === '--help' || argv[0] === '-h') { console.log(HELP); process.exit(0); }

  const d = load();
  if (!d) {
    console.error(`基线数据文件缺失或损坏: ${DATA}`);
    console.error('（应由 scripts/lib/convert_chintravel.py 从 ChinaTravel-Sandbox 的 attractions parquet 生成）');
    process.exit(1);
  }

  if (argv[0] === 'cities') {
    console.log(`有基线的城市（${d.cities.length} 个，共 ${d.spots.length} 个景点）:`);
    d.cities.forEach(c => console.log(`  ${c}  ${d.counts[c]} 个`));
    console.log('\n城市不在列时：CHINATRAVEL=0 —— 该目的地退回 web_search 查开放时间。');
    process.exit(0);
  }

  const city = String(argv[0]).replace(/[市]/g, '');
  const limitIdx = argv.indexOf('--limit');
  let limit = 40;
  if (limitIdx >= 0) {
    const n = Number(argv[limitIdx + 1]);
    if (!Number.isInteger(n) || n < 1) { console.error('--limit 需要正整数'); process.exit(1); }
    limit = n;
  }
  const searchIdx = argv.indexOf('--search');
  const search = searchIdx >= 0 ? String(argv[searchIdx + 1] || '') : '';
  const asJson = argv.includes('--json');
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--limit' || a === '--search') { i++; continue; }
    if (a === '--json' || a === 'cities') continue;
    if (a.startsWith('--')) { console.error('未知参数: ' + a + '（--help 看用法）'); process.exit(1); }
  }

  if (!CITIES.includes(city)) {
    // 未覆盖：明确输出决策码，让上层直接退回 web_search，不要在这里失败
    console.log(`CHINATRAVEL=0  「${city}」不在基线覆盖范围内（仅 ${CITIES.join('/')}）`);
    console.log('→ 该目的地**退回 web_search** 查景点开放时间与门票；本条不是错误。');
    process.exit(2);
  }

  let list = d.spots.filter(s => s.city === city);
  if (search) list = list.filter(s => String(s.name || '').includes(search));

  if (asJson) {
    process.stdout.write(JSON.stringify({ city, count: list.length, spots: list.slice(0, limit) }, null, 1) + '\n');
    process.exit(0);
  }

  console.log(`CHINATRAVEL=1  ${city} 基线：命中 ${list.length} 个景点${search ? `（按「${search}」过滤）` : ''}${list.length > limit ? `，此处列前 ${limit} 个` : ''}`);
  console.log('# 名称 · 类型 · 开放时间 · 门票(元) · 建议游览(小时)');
  list.slice(0, limit).forEach(s => {
    const price = s.price === 0 ? '免费' : (s.price == null ? '—' : `¥${s.price}`);
    const visit = (s.visitMin != null && s.visitMax != null)
      ? (s.visitMin === s.visitMax ? `${s.visitMin}h` : `${s.visitMin}–${s.visitMax}h`) : '—';
    console.log(`${s.name} · ${s.type || '—'} · ${s.hours || '—'} · ${price} · ${visit}`);
  });
  console.log('');
  console.log('⚠ 开放时间为**常规时段口径**，旺季/节假日会调整——选入最终名单后**仍须**按景区官网最近公告核对；');
  console.log('   查不到就按技能规则写"以景区公示为准"。基线只用来免去重复检索，不是最终依据。');
  process.exit(0);
}

main();
