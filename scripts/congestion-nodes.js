#!/usr/bin/env node
/**
 * congestion-nodes.js —— 「避堵设计链」①②③ 的唯一入口（2026-10-09 新增）
 *
 * 做什么（对应 references/driving-route-planning.md §1）：
 *   ① 定主线：按起终点取**地图最快路线**（strategy=32，默认全程高速），记里程 / 耗时 / 折线
 *   ② 沿主线逐段取证：把结论库（data/high-congestion/segments.json）里**被点名**的路段
 *      按地名定位，算它离主线折线多远（默认 ≤15 km 记为「压线」＝需要处理的节点）
 *   ③ 给节点排名（**现阶段只排名、不打分**）：压线 → 命中次数（年+节假日计次）→ 最新命中年份
 *      → 施工/隧道群/枢纽/省界 → 主线先后；排名前 N 的节点标记 needDetail=true（要出精细化图）
 *
 * 用法:
 *   node scripts/congestion-nodes.js <route.json> [--date 2026-10-01] [--out nodes.json]
 *                                    [--top 3] [--max-off 15] [--debug] [--json] [--quiet] [--marks marks.json]
 *   node scripts/congestion-nodes.js --selfcheck        # 不联网：自检地名切分 / 聚类 / 排序
 *   node scripts/congestion-nodes.js --help
 *
 * route.json:
 *   { "from": {"name":"宁德市","lng":119.5275,"lat":26.6592},
 *     "to":   {"name":"田东县","lng":107.1261,"lat":23.6001},
 *     "vias": [] }                       // 可选；定主线时**不要**放途经点（那是④的事）
 *
 * 环境变量: AMAP_KEY（只从环境变量读，本脚本**不写任何 key**）
 * 输出: 我们的结论（节点名 / 线上里程 / 命中次数 / 年份 / 来源 / 排名），**厂商原始响应不落盘**；
 *       注意 **它不是 map-shot --nodes 的 marks**（没有 lng/lat/type/label/labelDir）：
 *       要出图得先按 km 投影到折线补 lng/lat，并补 type:"point"/label/labelDir
 * 退出码: 0 成功；1 用法或数据错误；2 网络 / 接口失败
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const LIB = path.join(__dirname, '..', 'data', 'high-congestion', 'segments.json');
const HELP = `congestion-nodes.js —— 避堵链 ①②③（最快线 → 逐段取证 → 节点排名）

用法:
  node scripts/congestion-nodes.js <route.json> [--date YYYY-MM-DD] [--out nodes.json]
                                   [--top 3] [--max-off 15] [--debug] [--json] [--quiet] [--marks marks.json]
  node scripts/congestion-nodes.js --selfcheck
  node scripts/congestion-nodes.js --help

route.json:
  { "from": {"name":"宁德市","lng":119.5275,"lat":26.6592},
    "to":   {"name":"田东县","lng":107.1261,"lat":23.6001}, "vias": [] }

说明:
  · 主线上**被点名且压线**的路段才进排名；没被点名的写「未发现被点名路段」（本库没有 ≠ 不堵）
  · 排名依据：压线 → 命中次数(年+节假日) → 最新命中年份 → 施工/隧道群/枢纽/省界 → 主线先后
  · **严重度由本脚本判定**（不再人工上色，输出 level）：
      深红 high = 命中 ≥4 次 **或** 出发年(--date 所在年)被官方点名
      红   mid  = 命中 2–3 次 **或** 最新命中年份 = 出发年 - 1
      浅红 low  = 其余（不给 --date 时照出 high/mid/low，mid 仍按命中 2–3 次判定）
  · 现阶段**只排名不打分**；评分制（次数 5 / 中位数 5 / 平均 3 / 最长 2，>8 分必须精细化）等拿到时长数据再用
  · AMAP_KEY 只从环境变量读；厂商原始响应不落盘，输出的是我们自己的结论
  · --marks <marks.json> 直接产出 map-shot.js shot --nodes 能吃的标记文件（每个节点按 km 投到主线上、
   名字取路段名、红点按严重度分色、labelDir:"w" 水平引线），省掉手工把 nodes.json 转 marks 的一步
  · --debug 打印逐条核查过程（每个锚点取到多远、疑似平行线），排查"某节点为什么没上榜"时用
`;

// ── 纯函数（可离线自检）──────────────────────────────────────────────────────
const PI = Math.PI;
const hav = (a, b) => {
  const R = 6371, dLat = (b[1] - a[1]) * PI / 180, dLng = (b[0] - a[0]) * PI / 180;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * PI / 180) * Math.cos(b[1] * PI / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
};

// 从「路段原文」切出可定位的地名候选（如「思林至平果铝 K697+200—K695+000 段」→ 思林 / 平果铝）
const DROP = /^(路段|段|方向|高速|国道|省道|县道|服务区|停车区|隧道群|隧道|特大桥|大桥|中桥|桥|枢纽|互通|立交|收费站|服务区路|施工|改扩建|拼宽|工程|路段内|境内|附近|一带|沿线|区间|至|到)$/;
function placeTokens(text) {
  const raw = String(text || '')
    .replace(/[（(][^）)]*[）)]/g, ' ')
    .replace(/K\d+[+\-—~～]?\d*/gi, ' ')
    .replace(/[“”"'’]/g, '');
  const parts = raw.split(/[至到—－–\-~～、,，;；:：/|]|\s+/);
  const out = [];
  for (let p of parts) {
    p = p.trim().replace(DROP, '').replace(/^(G|S)\d+/, '');
    p = p.replace(/(段|路段|方向|隧道群|隧道|大桥|特大桥|中桥|枢纽|互通|立交|收费站|服务区|停车区|施工|改扩建|拼宽|工程)$/g, '');
    const cn = p.match(/[\u4e00-\u9fa5]{2,}/g);
    if (!cn) continue;
    for (const c of cn) {
      if (c.length < 2 || c.length > 8) continue;
      if (DROP.test(c)) continue;
      if (!out.includes(c)) out.push(c);
    }
  }
  return out.slice(0, 3);
}

// 路段属性标记（用于并列时的排名）
function segmentFlags(text) {
  const t = String(text || '');
  return {
    施工: /施工|改扩建|拼宽|四改八|养护/.test(t),
    隧道群: /隧道群|隧道/.test(t),
    枢纽: /枢纽|互通|立交/.test(t),
    省界: /省界|出省|省际/.test(t),
  };
}

// 按「线上里程 + 同一条路」聚类成节点
function clusterNodes(items, { spanKm = 25, maxOff = 15 } = {}) {
  const byRoadKm = items.slice().sort((a, b) => (a.km - b.km) || String(a.road).localeCompare(String(b.road)));
  const roadKey = r => String(r || '').split(/\s+/)[0];
  const nodes = [];
  for (const it of byRoadKm) {
    // 锚点固定用**簇内第一条**的里程（不随均值漂移，否则相距 25 km 的多个点会被连成长节点）
    const hit = nodes.find(n => Math.abs(n.km0 - it.km) <= spanKm && n.roads.has(roadKey(it.road)));
    if (hit) {
      hit.items.push(it);
      hit.km = Math.round(hit.items.reduce((s, x) => s + x.km, 0) / hit.items.length);
      hit.off = Math.min(hit.off, it.off);
    } else {
      nodes.push({ km0: it.km, km: it.km, off: it.off, roads: new Set([roadKey(it.road)]), items: [it] });
    }
  }
  for (const n of nodes) {
    const keys = new Set();
    const years = new Set();
    const pubs = new Set();
    const segs = new Set();
    for (const it of n.items) {
      keys.add(`${it.year}|${it.holiday}`);
      years.add(it.year);
      pubs.add(it.publisher);
      segs.add(`${it.road}｜${it.segment}`);
    }
    const allText = n.items.map(i => i.segment).join(' ');
    n.hits = keys.size;
    n.years = [...years].sort();
    n.latest = Math.max(...years);
    n.publishers = [...pubs];
    n.segments = [...segs];
    n.roadsArr = [...new Set(n.items.map(i => i.road))];
    n.flags = segmentFlags(allText);
    n.onRoute = n.off <= maxOff;
    n.needsReview = n.items.some(i => i.needsReview);
    // 只在"压线的那些记录"里判断：簇内压线记录**全部**与实走/锚点路名不符 → 判为平行线
    const onItems = n.items.filter(i => i.off <= maxOff);
    n.roadMismatch = onItems.length > 0 && onItems.every(i => i.roadMismatch);
    delete n.roads; delete n.km0;
  }
  return nodes;
}

function rankNodes(nodes, depYear) {
  const flagScore = n => (n.flags.施工 ? 4 : 0) + (n.flags.隧道群 ? 3 : 0) + (n.flags.枢纽 ? 2 : 0) + (n.flags.省界 ? 1 : 0);
  const on = nodes.filter(n => n.onRoute && !n.roadMismatch).sort((a, b) =>
    (b.hits - a.hits) || (b.latest - a.latest) || (flagScore(b) - flagScore(a)) || (a.km - b.km));
  on.forEach((n, i) => { n.rank = i + 1; });
  nodes.filter(n => !n.onRoute || n.roadMismatch).forEach(n => { n.rank = null; });
  for (const n of nodes) {
    const s = severityOf(n, depYear);
    n.level = s.level; n.levelWhy = s.why;
  }
  return nodes;
}

/**
 * 严重度（脚本判定，不再人工上色）：
 *   high 深红 = 命中 ≥4 次（年+节假日计次）**或** 出发年被官方点名
 *   mid  红   = 命中 2–3 次 **或** 最新命中年份 = 出发年 - 1
 *   low  浅红 = 其余
 */
function severityOf(n, depYear) {
  const depNamed = !!depYear && n.years.includes(depYear);
  if (n.hits >= 4) return { level: 'high', why: `命中 ${n.hits} 次（≥4）` };
  if (depNamed) return { level: 'high', why: `出发年 ${depYear} 被官方点名` };
  if (n.hits >= 2) return { level: 'mid', why: `命中 ${n.hits} 次` };
  if (depYear && n.latest === depYear - 1) return { level: 'mid', why: `最新命中 ${n.latest}（出发年前一年）` };
  return { level: 'low', why: `仅 ${n.hits} 次、最新 ${n.latest}` };
}

// 本线在该里程**实际走的是哪条高速**（从路线 instruction 里取）——用来挡"平行线"假压线
const ROAD_NAMES = /长深|福银|泉南|京台|沈海|广昆|兰海|包茂|汕昆|莆炎|二广|许广|厦蓉|宁光|茶常|平那|三南|深岑|南百|南宁绕城|武深|沪昆|大广|南韶|呼北|政永|宁武|清三/g;
function roadTokensOf(text) {
  const codes = new Set((String(text).match(/[GS]\d{2,4}/g) || []));
  const names = new Set((String(text).match(ROAD_NAMES) || []));
  return { codes, names };
}
function roadsNear(route, km, span = 30) {
  const steps = route.steps || [];
  // s.km 是该段**末端**累计里程：几十公里不换路的长 step 会跨过查询点、却不满足 |s.km-km|<=span，
  // 于是窗口取空 → 本线 token 为空 → 压线记录被**误判成平行线**剔除（真丢点，如 G45 衡水段）。
  // 所以按 step 覆盖区间 [km-dist-span, km+span] 取，真取不到再退回“里程最近的 3 个 step”。
  let pick = steps.filter(s => (s.km - (s.dist || 0) - span) <= km && (s.km + span) >= km);
  if (!pick.length) pick = steps.slice().sort((a, b) => Math.abs(a.km - km) - Math.abs(b.km - km)).slice(0, 3);
  return roadTokensOf(pick.map(s => s.instruction || '').join(' '));
}
function roadMatches(road, near) {
  const tok = roadTokensOf(road);
  // 本线在窗口内取不到任何路名（缺 step / 认不出）→ 判不了，不判错，交人工核对
  if (near.codes.size === 0 && near.names.size === 0) return true;
  for (const c of tok.codes) if (near.codes.has(c)) return true;
  for (const n of tok.names) if (near.names.has(n)) return true;
  return tok.codes.size === 0 && tok.names.size === 0;   // 认不出路名时不判错，交人工
}

// ── 联网部分 ────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));
let KEY = process.env.AMAP_KEY;

async function api(url) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url);
      const j = await r.json();
      if (j.status === '1') return j;
      if (['10003', '10004', '10021', '10019'].includes(String(j.infocode))) { await sleep(600 * (i + 1)); continue; }
      return { _err: `${j.info}/${j.infocode}` };
    } catch (e) { await sleep(600 * (i + 1)); }
  }
  return { _err: '网络失败' };
}

async function fastestRoute(from, to, vias = []) {
  const u = new URL('https://restapi.amap.com/v5/direction/driving');
  u.searchParams.set('key', KEY);
  u.searchParams.set('origin', `${from.lng},${from.lat}`);
  u.searchParams.set('destination', `${to.lng},${to.lat}`);
  if (vias.length) u.searchParams.set('waypoints', vias.map(v => `${v.lng},${v.lat}`).join(';'));
  u.searchParams.set('strategy', '32');
  u.searchParams.set('show_fields', 'cost,polyline');
  const j = await api(u);
  if (j._err || !j.route) throw new Error('取最快路线失败: ' + (j._err || 'no route'));
  const p = j.route.paths[0];
  const pts = [];
  const steps = [];
  let acc = 0;
  for (const st of p.steps) {
    acc += (+st.step_distance || 0) / 1000;
    steps.push({ km: Math.round(acc), instruction: String(st.instruction || '') });
    for (const s of (st.polyline || '').split(';')) {
      const [lo, la] = s.split(',').map(Number);
      if (Number.isFinite(lo) && Number.isFinite(la)) pts.push([lo, la]);
    }
  }
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + hav(pts[i - 1], pts[i]));
  return { dist: +p.distance, dur: +p.cost.duration, pts, cum, steps, total: cum[cum.length - 1] };
}

const geoCache = new Map();
const normProv = s => String(s || '').replace(/(省|市|自治区|壮族|回族|维吾尔|特别行政区|自治州|地区)/g, '');
// scope（结论库里的省别）用来挡"同名异地"错配：福建的记录定位到广西必须丢掉
function provMatch(scope, province) {
  const a = normProv(scope), b = normProv(province);
  if (!a || a === '全国') return true;
  if (!b) return false;
  return a.includes(b) || b.includes(a);
}
// ── 地名三态验证（2026-10-10 加）：match 采用 / did-you-mean 存疑（须人工确认，不许直接当卡点）/ no-match 丢弃 ──
// 规则：要的是"高速要素"（收费站/互通/服务区/…）却解析成别的东西 → 存疑；解析出的地址里含不住词干 → 存疑
function verifyAnchor(token, addr) {
  const A = String(addr);
  const PROV = /^(广东|福建|江西|广西|湖南|湖北|河南|河北|山东|山西|陕西|甘肃|青海|辽宁|吉林|黑龙江|内蒙古|宁夏|新疆|西藏|四川|贵州|云南|浙江|江苏|安徽|海南|天津|北京|上海|重庆|台湾)/;
  let core = String(token).replace(PROV, '').replace(/[（(].*$/, '')
    .replace(/(收费站|互通|服务区|停车区|枢纽|立交|隧道群|隧道|镇|乡|县|市|区|村|段|方向)$/g, '');
  if (core.length < 2) return 'match';
  const chars = [...new Set(core)];
  const ratio = chars.filter(c => A.includes(c)).length / chars.length;
  const feat = /(收费站|互通|服务区|停车区|枢纽|立交|隧道)/.exec(token);
  if (feat && !A.includes(feat[1]) && ratio < 0.8) return 'did-you-mean';   // 要高速要素，却解析成别的东西
  return ratio >= 0.6 ? 'match' : 'did-you-mean';                          // 字元重合度太低 → 存疑
}
async function geocodeAny(tokens, scope) {
  for (const t of tokens) {
    const key = `${t}|${scope || ''}`;
    // 裸地名（不带收费站/互通/服务区等高速要素）命中时标 weak —— 可能撞同名村庄，需人工确认
    const weak = !/(收费站|互通|服务区|停车区|枢纽|立交|隧道)/.test(t);
    if (geoCache.has(key)) { const v = geoCache.get(key); if (v) return v; continue; }
    let v = null;
    const u = new URL('https://restapi.amap.com/v3/geocode/geo');
    u.searchParams.set('key', KEY); u.searchParams.set('address', t);
    let j = await api(u);
    let g = j.geocodes && j.geocodes[0];
    if (g && g.location) {
      const p = g.province || g.city || '';
      const addr = `${g.formatted_address || t}`;
      if (provMatch(scope, p)) v = { lng: +g.location.split(',')[0], lat: +g.location.split(',')[1], addr, province: p, weak, verify: verifyAnchor(t, addr) };
    }
    if (!v) {
      const q = new URL('https://restapi.amap.com/v3/place/text');
      q.searchParams.set('key', KEY); q.searchParams.set('keywords', t); q.searchParams.set('offset', '5');
      j = await api(q);
      for (const poi of (j.pois || [])) {
        if (!poi.location) continue;
        const p = poi.pname || poi.cityname || '';
        if (!provMatch(scope, p)) continue;
        const addr = `${poi.name}|${p}${poi.cityname || ''}${poi.adname || ''}`;
        v = { lng: +poi.location.split(',')[0], lat: +poi.location.split(',')[1], addr, province: p, weak, verify: verifyAnchor(t, addr) };
        break;
      }
    }
    geoCache.set(key, v);
    await sleep(220);
    if (v) return v;
  }
  return null;
}

function pointAtKm(route, km) {
  let i = 1;
  while (i < route.cum.length - 1 && route.cum[i] < km) i++;
  return route.pts[Math.min(i, route.pts.length - 1)];
}

function projectOnRoute(coord, route) {
  let best = Infinity, km = 0;
  for (let i = 0; i < route.pts.length; i++) {
    const d = hav([coord.lng, coord.lat], route.pts[i]);
    if (d < best) { best = d; km = route.cum[i]; }
  }
  return { off: +best.toFixed(2), km: Math.round(km) };
}

// ── 主流程 ──────────────────────────────────────────────────────────────────
async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--selfcheck')) return selfcheck();
  if (!argv.length || argv.includes('--help') || argv.includes('-h')) { process.stdout.write(HELP); process.exit(0); }
  let asJson = false, quiet = false, debug = false;
  let top = 3, maxOff = 15, date = '', outFile = '', marksFile = '', routeFile = '';
  const need = (i, name) => {
    const v = argv[i + 1];
    if (v === undefined || String(v).startsWith('--')) { console.error(`参数 ${name} 缺少取值（--help 看用法）`); process.exit(1); }
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--top') { top = Number(need(i++, '--top')); if (!Number.isFinite(top) || top <= 0) { console.error('--top 需要正整数'); process.exit(1); } }
    else if (a === '--max-off') { maxOff = Number(need(i++, '--max-off')); if (!Number.isFinite(maxOff)) { console.error('--max-off 需要数字'); process.exit(1); } }
    else if (a === '--date') { date = String(need(i++, '--date')); if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { console.error('--date 需要 YYYY-MM-DD（如 2026-10-01），否则「出发年被点名→high」会静默失效'); process.exit(1); } }
    else if (a === '--out') outFile = need(i++, '--out');
    else if (a === '--marks') marksFile = need(i++, '--marks');
    else if (a === '--json') asJson = true;
    else if (a === '--quiet') quiet = true;
    else if (a === '--debug') debug = true;
    else if (a === '--selfcheck' || a === '--help' || a === '-h') { /* 前面已处理 */ }
    else if (a.startsWith('--')) { console.error(`未知参数: ${a}（--help 看用法）`); process.exit(1); }
    else routeFile = a;
  }
  if (!routeFile) { console.error('用法: congestion-nodes.js <route.json> [--date YYYY-MM-DD] [--out nodes.json] [--top 3] [--max-off 15] [--debug] [--json] [--quiet] [--marks marks.json]'); process.exit(1); }
  if (!fs.existsSync(routeFile)) { console.error('线路文件不存在: ' + routeFile); process.exit(1); }
  if (!KEY) { console.error('缺少 AMAP_KEY（只从环境变量读，本脚本不写 key）——没有 key 时**不要卡住**：① 用 `traffic-history.js --match` 的库结论列出被点名路段；② 用 `map-shot.js link` 出免 key 的地图链接 + 截图；③ 把节点排名写成「按库结论人工排序，未做取线校验」如实交付（见 references/driving-route-planning.md §5 末尾）'); process.exit(1); }
  if (!fs.existsSync(LIB)) { console.error('结论库不存在: ' + LIB); process.exit(1); }

  const spec = JSON.parse(fs.readFileSync(routeFile, 'utf8').replace(/^\uFEFF/, ''));
  const route = await fastestRoute(spec.from, spec.to, spec.vias || []);
  if (!quiet) console.log(`① 主线（最快路线）：${(route.dist / 1000).toFixed(1)} km / ${(route.dur / 3600).toFixed(2)} h，折线 ${route.pts.length} 点`);

  // ② 逐段取证
  const lib = JSON.parse(fs.readFileSync(LIB, 'utf8'));
  const records = Array.isArray(lib) ? lib : (lib.records || []);
  const items = [];
  const unmatched = [];
  if (!quiet) process.stdout.write(`② 逐段取证：${records.length} 条记录 `);
  for (const r of records) {
    const toks = placeTokens(r.segment);
    if (!toks.length) { unmatched.push({ road: r.road, segment: r.segment, reason: '切不出地名' }); continue; }
    const anchors = [];
    const suspicious = [];
    for (const t of toks) {
      // 先用**高速要素**（收费站/互通/服务区）定位，裸地名放最后——裸地名会撞同名村庄
      const g = await geocodeAny([t + '收费站', t + '互通', t + '服务区', t], r.scope);
      if (g && g.verify === 'match') anchors.push(g);
      else if (g) suspicious.push(`${t} → ${g.addr}（存疑）`);
      if (anchors.length >= 2) break;
    }
    if (!anchors.length) {
      unmatched.push({
        road: r.road, segment: r.segment, scope: r.scope,
        verify: suspicious.length ? 'did-you-mean' : 'no-match',
        reason: suspicious.length ? `地名未通过验证：${suspicious[0]}` : '地名定位失败或与省别不符',
      });
      continue;
    }
    // 跨段记录（A 至 B）**不用中点**：两个锚点各自投影到主线，取离主线最近的那个当记录位置，
    // 另一个锚点连同它的距离一起留档——避免"中点落在主线上"这种假压线。
    const proj = anchors.map(a => ({ addr: a.addr, weak: !!a.weak, ...projectOnRoute(a, route) }));
    const best = proj.reduce((x, y) => (y.off < x.off ? y : x));
    // 待人工确认：① 用了裸地名定位（可能撞同名村庄）② 跨段记录只有一端落在线附近（另一端 >2 倍阈值）
    const far = proj.length === 2 && (Math.max(...proj.map(p => p.off)) > maxOff * 2);
    const needsReview = proj.some(p => p.weak) || far;
    // 路由核对：优先用**锚点自带的道路名**（如「沙县收费站(G25长深高速出口)」）与记录的路名比；
    // 锚点没带路名（裸地名）时，退回用本线 instruction 里该里程实际走的高速比。
    const rTok = roadTokensOf(r.road);
    const bIdx = proj.findIndex(p => p.off === best.off);
    const aTok = roadTokensOf(proj[bIdx] ? proj[bIdx].addr : '');
    let roadMismatch = false;
    if (best.off <= maxOff) {
      // 必须**同时**满足两条：① 锚点自带路名与记录一致 ② **本线该里程实际走的高速**也要与记录一致
      // （只比 ① 会漏掉"锚点与记录同为 G80、但我们实际在平行 S52 上跑"这种假压线）
      const routeOk = roadMatches(r.road, roadsNear(route, best.km));
      const anchorOk = (aTok.codes.size || aTok.names.size)
        ? ([...aTok.codes].some(c => rTok.codes.has(c)) || [...aTok.names].some(n => rTok.names.has(n)))
        : true;
      roadMismatch = !(anchorOk && routeOk);
    }
    const item = {
      year: r.year, holiday: r.holiday, road: r.road, segment: r.segment, kind: r.kind,
      publisher: r.publisher, url: r.url, scope: r.scope, off: best.off, km: best.km, needsReview, roadMismatch,
      anchors: proj.map(p => `${p.addr}（离主线 ${p.off} km @ ${p.km} km${p.weak ? '·裸地名' : ''}）`),
    };
    items.push(item);
    if (debug) console.log(`   [debug] ${r.road}｜${r.segment}\n           ${item.anchors.join('\n           ')}  → 取 ${best.off} km @ ${best.km} km${roadMismatch ? '  ⚠ 与本线实走高速不符（疑似平行线）' : ''}`);
    if (!quiet) process.stdout.write('.');
  }
  if (!quiet) console.log('');

  // ③ 聚类 + 排名 + 严重度（脚本判定，不人工上色）
  const depYear = date ? Number(String(date).slice(0, 4)) : 0;
  const nodes = rankNodes(clusterNodes(items, { maxOff }), depYear);
  const onRoute = nodes.filter(n => n.rank != null).sort((a, b) => a.rank - b.rank);
  onRoute.forEach(n => { n.needDetail = n.rank <= top; });

  const out = {
    generatedAt: new Date().toISOString().slice(0, 10),
    date: date || null,
    route: { from: spec.from, to: spec.to, distanceKm: +(route.dist / 1000).toFixed(1), durationH: +(route.dur / 3600).toFixed(2), polylinePoints: route.pts.length },
    criteria: {
      maxOffKm: maxOff, topN: top,
      rankBy: ['压线', '命中次数(年+节假日)', '最新命中年份', '施工/隧道群/枢纽/省界', '主线先后'],
      severity: {
        rule: 'high 深红 = 命中≥4 次 或 出发年被官方点名；mid 红 = 命中 2–3 次 或 最新年份=出发年-1；low 浅红 = 其余',
        departureYear: depYear || null, computedBy: 'scripts/congestion-nodes.js',
      },
    },
    scoring: { enabled: false, status: '未启用（拿不到分段时长数据，现阶段只排名不打分）', planned: { 历史拥堵次数: 5, 拥堵中位数时长: 5, 平均时长: 3, 最长时长: 2, 阈值: 8 } },
    nodes: onRoute.map(n => ({
      rank: n.rank, needDetail: n.needDetail,
      km: n.km, offRouteKm: n.off,
      roads: n.roadsArr, segments: n.segments,
      hits: n.hits, years: n.years, latestYear: n.latest,
      level: n.level, levelWhy: n.levelWhy,
      needsReview: !!n.needsReview,
      flags: n.flags, publishers: n.publishers,
      anchors: [...new Set(n.items.flatMap(i => i.anchors || []))],
      urls: [...new Set(n.items.map(i => i.url))],
      evidence: n.items.map(i => `${i.year} ${i.holiday} · ${i.kind} · ${i.publisher}`),
    })),
    notOnRouteCount: nodes.filter(n => !n.onRoute).length,
    parallelExcluded: nodes.filter(n => n.onRoute && n.roadMismatch).map(n => ({
      km: n.km, offRouteKm: n.off, roads: n.roadsArr, segments: n.segments, hits: n.hits, years: n.years,
      reason: '与本线该里程实际所在高速不符（疑似平行线，未纳入排名）',
    })),
    unmatched,
    notes: [
      '本库没有记录 ≠ 不堵：没被点名只能写「未发现被点名路段」',
      '厂商原始响应不落盘，本文件只存我们的结论与来源引用',
      '出发日 24 h 内或当天，另按实时逐段路况复核（见 driving-route-planning.md §1 ②c）',
    ],
  };
  if (outFile) { fs.writeFileSync(outFile, JSON.stringify(out, null, 2), 'utf8'); if (!quiet) console.log(`已写出 ${outFile}`); }
  if (marksFile) {
    const LVC = { high: '#C62828', mid: '#F4511E', low: '#FF8A80' };
    const marks = onRoute.map(n => {
      const p = pointAtKm(route, n.km);
      const seg = String((n.segments && n.segments[0]) || '');
      const cand = (seg.split('｜')[1] || seg.split('｜')[0] || '').replace(/（.*$/, '').trim();
      const label = (cand.match(/([\u4e00-\u9fa5A-Za-z0-9]{2,10}(?:段|枢纽|互通|立交|服务区|省界|隧道群|大桥))/) || [])[1]
        || cand.split(/[、；;，,]/)[0].slice(0, 10) || n.roadsArr[0] || '拥堵段';
      return { type: 'point', color: LVC[n.level] || LVC.low, r: n.level === 'high' ? 6 : 5, label, labelDir: 'w', lng: p[0], lat: p[1], km: n.km, level: n.level };
    });
    const markDoc = {
      generatedAt: new Date().toISOString().slice(0, 10),
      legend: false, parallel: true,
      note: '由 congestion-nodes.js --marks 生成；labelDir:w ＝ 水平引线向西引出段名；颜色按严重度 high/mid/low',
      marks,
    };
    fs.writeFileSync(marksFile, JSON.stringify(markDoc, null, 2), 'utf8');
    if (!quiet) console.log(`已写出 ${marksFile}（${marks.length} 个红点，直接给 map-shot.js shot ... --nodes）`);
  }
  if (asJson) { console.log(JSON.stringify(out, null, 2)); return; }
  if (!quiet) {
    console.log(`\n③ 主线上被点名且压线的节点（≤${maxOff} km）共 ${onRoute.length} 个：`);
    console.log('排名  线上里程  离主线  命中  最新年  严重度  判定依据  路段');
    const LV = { high: '深红', mid: '红', low: '浅红' };
    for (const n of onRoute) {
      console.log(`${String(n.rank).padStart(3)}  ${String(n.km).padStart(6)} km  ${String(n.off).padStart(5)} km  ${String(n.hits).padStart(3)}  ${String(n.latest).padStart(5)}  ${(LV[n.level] || n.level).padStart(4)}  ${String(n.levelWhy).padEnd(22)}  ${n.segments[0]}${n.needDetail ? '   ← 精细化' : ''}${n.needsReview ? '   ? 待人工确认' : ''}`);
    }
    console.log(`\n不在主线上（仅备查）：${out.notOnRouteCount} 个节点；疑似平行线（已剔除）：${out.parallelExcluded.length} 个；定位失败：${unmatched.length} 条`);
    for (const p of out.parallelExcluded) console.log(`  平行线剔除：@${p.km} km  ${p.roads.join('+')}｜${p.segments[0]}`);
    if (unmatched.length) console.log('定位失败明细：' + unmatched.slice(0, 8).map(u => `${u.road}/${u.segment}(${u.reason})`).join('；'));
  }
}

function selfcheck() {
  const t1 = placeTokens('思林至平果铝 K697+200—K695+000 段');
  const t2 = placeTokens('桂林北互通立交至僚田互通立交段');
  const t3 = placeTokens('泉州南安（泉州往三明）');
  const has = (arr, s) => arr.some(x => x.includes(s));
  const okTokens = has(t1, '思林') && has(t1, '平果铝') && has(t2, '桂林北') && has(t2, '僚田') && has(t3, '南安');
  const items = [
    { year: 2021, holiday: '国庆', road: 'G72 泉南高速', segment: 'A', km: 100, off: 1 },
    { year: 2022, holiday: '春节', road: 'G72 泉南高速', segment: 'A2', km: 110, off: 1 },
    { year: 2026, holiday: '国庆', road: 'G72 泉南高速', segment: 'B', km: 130, off: 2 },
    { year: 2026, holiday: '国庆', road: 'G80 广昆高速', segment: 'C', km: 105, off: 40 },
  ];
  const nodes = rankNodes(clusterNodes(items, { maxOff: 15 }), 2026);
  const on = nodes.filter(n => n.onRoute).sort((a, b) => a.rank - b.rank);
  const clustered = on.length === 2;
  const ranked = on[0].hits === 2 && on[0].latest === 2022 && on[1].hits === 1 && on[1].latest === 2026;
  // 严重度：2 次命中 → 红(mid)；1 次但命中出发年 2026 → 深红(high)；不给日期 → 回落浅红(low)
  const levelOk = on[0].level === 'mid' && on[1].level === 'high' && /出发年 2026/.test(on[1].levelWhy || '');
  const noDate = rankNodes(clusterNodes(items, { maxOff: 15 }), 0).filter(n => n.onRoute).sort((a, b) => a.rank - b.rank);
  const levelNoDate = noDate[1] && noDate[1].level === 'low';
  const offNotRanked = nodes.filter(n => !n.onRoute).every(n => n.rank === null);
  const flags = segmentFlags('K697+200—K695+000 段施工') .施工 === true;
  const pass = okTokens && clustered && ranked && levelOk && levelNoDate && offNotRanked && flags;
  console.log('地名切分  : ' + t1.join('/') + ' | ' + t2.join('/') + ' | ' + t3.join('/'));
  console.log('聚类+排名 : 线上节点 ' + on.length + ' 个，第1名 ' + on[0].hits + ' 次/最新 ' + on[0].latest);
  console.log('严重度    : ' + on.map(n => `${n.rank}→${n.level}（${n.levelWhy}）`).join(' / ') + '；不给出发日期时 2 号 = ' + (noDate[1] && noDate[1].level));
  console.log('不压线    : 不参与排名 ' + offNotRanked);
  console.log('属性标记  : 施工 ' + flags);
  console.log('自检节点  : ' + JSON.stringify(on.map(n => ({ rank: n.rank, hits: n.hits, latest: n.latest, km: n.km, level: n.level }))));
  console.log(pass ? 'selfcheck PASS' : 'selfcheck FAIL');
  process.exit(pass ? 0 : 1);
}

main().catch(e => {
  const net = /网络|接口|AMAP|fetch|ECONN|ETIMEDOUT|socket/i.test(String(e.message || e));
  console.error((net ? '接口失败: ' : '数据/用法错误: ') + e.message);
  process.exit(net ? 2 : 1);
});
