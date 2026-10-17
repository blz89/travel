#!/usr/bin/env node
/**
 * map-shot.js —— 自驾路线规划的「出图」唯一入口
 *
 *   link  <points.json>        生成高德链接（网页版 + App scheme），把起终点（必要时 +1 个 vias）交给地图
 *   shot  <url> <out.png>      用无头 Edge + CDP 打开该链接，**等地图渲染完成后截图**（截图即交付物）
 *
 * 为什么需要它（两条实测结论）：
 *   ① 把途经点交给地图：**高德网页版 URL** 的 via[i] 实测可用（10 个途经点全部被采纳），
 *      免 key、PC/手机通用；`policy=0` = 推荐（默认全程高速）。
 *      高德 App 也支持多途经点（Android `amapuri://route/plan/`、iOS `iosamap://path`，
 *      vian + vialons/vialats/vianames 竖线分隔，sourceApplication 必填但不是 key）。
 *      出图走**高德**：网页版免 key 且能被程序填参，App scheme 支持同样填 vias。
 *   ② 截图必须**等渲染完**：`msedge --screenshot` 在 load 事件就抓，地图还是白板（实测）；
 *      地图页还会弹登录浮层挡住右侧地图 —— 所以这里走 CDP：导航 → 等 → 关浮层 → 抓图。
 *
 * ⚠ 合规（硬性）：截图会带 `© 高德 GS(...)号` 版权信息——**必须保留、不得裁掉**；
 *    截图**仅供客户本人查看**，不得公开再分发或商用；要对外分发请改用 OSM（ODbL，需署名）底图。
 *
 * 用法:
 *   node scripts/map-shot.js link <points.json> [--out <file>] [--pretty]
 *   node scripts/map-shot.js shot <url> <out.png> [--wait 24000] [--w 1400] [--h 900] [--scale 2] [--nodes nodes.json] [--single [--pick N]] [--pref 不走高速] [--click x,y] [--js inject.js]
 *   node scripts/map-shot.js selfcheck            # 不联网：自检坐标系转换与链接拼装
 *   node scripts/map-shot.js --help
 *
 * points.json 形状:
 *   {
 *     "from": { "name": "福州", "lng": 119.2965, "lat": 26.0745 },
 *     "to":   { "name": "田东", "lng": 107.1261, "lat": 23.6001 },
 *     "policy": 0,                       // 0 推荐(默认全程高速) / 1 避免拥堵 / 2 避免收费；3 不走高速在网页版被忽略（要用 shot --pref）
 *     "coord": "gcj02",                  // gcj02(默认) / wgs84(脚本自动转 GCJ-02)
 *     "vias": [ { "name": "三明", "lng": 117.6389, "lat": 26.2637 }, … ]   // 建议 ≤10
 *   }
 *
 * 退出码: 0 成功；1 用法/数据错误；2 截图失败（浏览器/网络）
 * 依赖: Node ≥ 21（用全局 WebSocket 走 CDP）、本机 Microsoft Edge。不需要任何 key。
 */
'use strict';
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// ── 坐标：WGS-84 → GCJ-02（公开算法；GCJ-02 原样返回）────────────────────────
const PI = Math.PI, A = 6378245.0, EE = 0.00669342162296594323;
const outOfChina = (lng, lat) => !(lng > 73.66 && lng < 135.05 && lat > 3.86 && lat < 53.55);
function tLat(x, y) {
  let r = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  r += (20 * Math.sin(6 * x * PI) + 20 * Math.sin(2 * x * PI)) * 2 / 3;
  r += (20 * Math.sin(y * PI) + 40 * Math.sin(y / 3 * PI)) * 2 / 3;
  r += (160 * Math.sin(y / 12 * PI) + 320 * Math.sin(y * PI / 30)) * 2 / 3;
  return r;
}
function tLng(x, y) {
  let r = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  r += (20 * Math.sin(6 * x * PI) + 20 * Math.sin(2 * x * PI)) * 2 / 3;
  r += (20 * Math.sin(x * PI) + 40 * Math.sin(x / 3 * PI)) * 2 / 3;
  r += (150 * Math.sin(x / 12 * PI) + 300 * Math.sin(x / 30 * PI)) * 2 / 3;
  return r;
}
function wgs2gcj(lng, lat) {
  if (outOfChina(lng, lat)) return [lng, lat];
  const dLat0 = tLat(lng - 105, lat - 35), dLng0 = tLng(lng - 105, lat - 35);
  const radLat = lat / 180 * PI;
  let magic = Math.sin(radLat); magic = 1 - EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  const dLat = (dLat0 * 180) / ((A * (1 - EE)) / (magic * sqrtMagic) * PI);
  const dLng = (dLng0 * 180) / (A / sqrtMagic * Math.cos(radLat) * PI);
  return [lng + dLng, lat + dLat];
}
const r6 = (v) => Math.round(v * 1e6) / 1e6;
function toGcj(pt, coord) {
  const c = String(coord || 'gcj02').toLowerCase();
  if (c === 'gcj02' || c === 'amap' || c === 'gaode') return [r6(pt.lng), r6(pt.lat)];
  if (c === 'wgs84' || c === 'gps') { const [x, y] = wgs2gcj(pt.lng, pt.lat); return [r6(x), r6(y)]; }
  throw new Error(`未知坐标系: ${coord}（只认 gcj02 / wgs84）`);
}

// ── link：拼链接 ──────────────────────────────────────────────────────────────
const MAX_VIA = 10;          // 实测 10 个网页全部采纳；再多请分链接
function buildLinks(d) {
  for (const k of ['from', 'to']) {
    if (!d[k] || !Number.isFinite(Number(d[k].lng)) || !Number.isFinite(Number(d[k].lat))) throw new Error(`缺少 ${k}.lng / ${k}.lat`);
  }
  const coord = d.coord || 'gcj02';
  const F = toGcj(d.from, coord), T = toGcj(d.to, coord);
  const vias = (d.vias || []).map(v => ({ name: String(v.name || ''), ...(() => { const [x, y] = toGcj(v, coord); return { lng: x, lat: y }; })() }));
  const policy = Number.isFinite(Number(d.policy)) ? Number(d.policy) : 0;
  const E = encodeURIComponent;
  const web = 'https://ditu.amap.com/dir?type=car&policy=' + policy
    + `&from[lnglat]=${F[0]},${F[1]}&from[name]=${E(d.from.name || '起点')}`
    + `&to[lnglat]=${T[0]},${T[1]}&to[name]=${E(d.to.name || '终点')}`
    + vias.map((v, i) => `&via[${i}][lnglat]=${v.lng},${v.lat}&via[${i}][name]=${E(v.name)}`).join('');
  const q = vias.map(v => `${v.lng},${v.lat}`).join('|');
  const n = vias.map(v => v.name).join('|');
  const android = 'amapuri://route/plan/?sourceApplication=travel-skill&t=0'
    + `&slat=${F[1]}&slon=${F[0]}&sname=${E(d.from.name || '起点')}`
    + `&dlat=${T[1]}&dlon=${T[0]}&dname=${E(d.to.name || '终点')}`
    + (vias.length ? `&vian=${vias.length}&vialons=${vias.map(v => v.lng).join('|')}&vialats=${vias.map(v => v.lat).join('|')}&vianames=${n}` : '');
  const ios = android.replace('amapuri://route/plan/?', 'iosamap://path?');
  const warn = [];
  if (vias.length > MAX_VIA) warn.push(`途经点 ${vias.length} 个 > 实测可用 ${MAX_VIA} 个：请拆成两条链接（前段 / 后段），或改用 App scheme / 让客户在 App 内手动加`);
  if (vias.length === 0) warn.push('没有途经点：这就是"起终点默认推荐"的普通路线（默认全程高速）');
  return { web, android, ios, vias: vias.length, coord, policy, warn, urlLen: web.length };
}

// ── shot：无头 Edge + CDP 截图 ────────────────────────────────────────────────
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function findEdge() {
  return ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].find(p => fs.existsSync(p));
}
async function shot(url, outPng, opt) {
  const WAIT = opt.wait, W = opt.w, H = opt.h, SCALE = opt.scale;
  const EDGE = findEdge();
  if (!EDGE) throw new Error('找不到 Microsoft Edge（msedge.exe）');
  if (typeof WebSocket !== 'function') throw new Error('需要 Node ≥ 21（全局 WebSocket）才能走 CDP');
  const PORT = 9222 + Math.floor(Math.random() * 400);
  const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'mapshot-'));
  // ⚠ stdio 必须是 ignore：沙箱下管道 stdio 会 EPERM
  const child = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
    `--window-size=${W},${H}`, '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--enable-unsafe-swiftshader', 'about:blank'], { stdio: 'ignore' });
  let ws = null;
  try {
    let target = null;
    for (let i = 0; i < 40 && !target; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
        target = list.find(t => t.type === 'page');
      } catch { /* 未就绪 */ }
      if (!target) await sleep(500);
    }
    if (!target) throw new Error('CDP 未就绪（浏览器没起来？）');
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('CDP WebSocket 连接失败')); });
    const pend = new Map(); let id = 0; const seen = new Set();
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
      else if (m.method) seen.add(m.method);
    };
    const cmd = (method, params = {}) => new Promise((res, rej) => {
      const mid = ++id; pend.set(mid, { res, rej });
      ws.send(JSON.stringify({ id: mid, method, params }));
      setTimeout(() => { if (pend.has(mid)) { pend.delete(mid); rej(new Error(method + ' 超时')); } }, 90000);
    });
    await cmd('Page.enable');
    await cmd('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: SCALE, mobile: false });
    await cmd('Page.navigate', { url });
    for (let i = 0; i < 120 && !seen.has('Page.loadEventFired'); i++) await sleep(500);
    await sleep(WAIT);                                   // 等瓦片 + 路线画完
    // 关掉登录/引导浮层：只按 Esc 关不掉（实测仍然挡着地图）→ 直接按文案找到弹层并隐藏
    let dismissed = 'none';
    try {
      await cmd('Runtime.enable');
      const r = await cmd('Runtime.evaluate', {
        returnByValue: true,
        expression: `(() => {
          const hit = [...document.querySelectorAll('div')].filter(d => /短信登录|二维码登录|立即登录/.test(d.textContent || '') && d.querySelectorAll('div').length < 40);
          if (!hit.length) return 'nomodal';
          let el = hit[hit.length - 1];
          for (let i = 0; i < 4 && el.parentElement; i++) el = el.parentElement;
          el.style.display = 'none';
          return 'hidden';
        })()`,
      });
      dismissed = (r && r.result && r.result.value) || 'unknown';
    } catch { dismissed = 'error'; }
    console.log(`  浮层处理: ${dismissed}`);
    await cmd('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }).catch(() => {});
    await cmd('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }).catch(() => {});
    await sleep(1500);
    if (opt.click) {
      for (const type of ['mousePressed', 'mouseReleased']) {
        await cmd('Input.dispatchMouseEvent', { type, x: opt.click[0], y: opt.click[1], button: 'left', clickCount: 1 }).catch(() => {});
      }
      await sleep(1200);
    }
    // ── 页面注入 JS（可选 --js <file>）：截图前把界面收拾干净，例如
    //    用「偏好」把备选路线筛掉、只留我们选定的那条。返回值直接打印出来。
    if (opt.js) {
      try {
        await cmd('Runtime.enable');
        const expr = fs.readFileSync(opt.js, 'utf8');
        const r = await cmd('Runtime.evaluate', { returnByValue: true, expression: expr, awaitPromise: true });
        const v = r && r.result && (r.result.value !== undefined && r.result.value !== null ? r.result.value : r.result.description);
        console.log(`  JS 注入: ${String(v).slice(0, 1500)}`);
      } catch (e) { console.log(`  JS 注入失败: ${String(e.message || e).slice(0, 200)}`); }
      await sleep(900);
    }
    // ── 先用「偏好」把路线偏好定下来（可选 --pref 不走高速）：实测 ditu.amap.com 的
    //    URL 参数 policy=3 会被忽略（照样给高速），只有点开「偏好」选「不走高速」才会
    //    真的按地面路算、并由地图自己把地面线画出来。
    if (opt.pref) {
      const pref = String(opt.pref);
      const expr = `(async () => {
        const sleep = ms => new Promise(r => setTimeout(r, ms));
        let trig = document.querySelector('[class*="preferenceTrigger"]') || document.querySelector('[class*="triggerLabel"]');
        if (!trig) trig = [...document.querySelectorAll('div,span')].find(e => /^(偏好|路线偏好)$/.test((e.textContent || '').trim()) && !e.children.length);
        if (!trig) return 'no-trigger';
        trig.click(); await sleep(1400);
        const want = ${JSON.stringify(pref)};
        const cands = [...document.querySelectorAll('li,div,span,a')].filter(e => !e.children.length && (e.textContent || '').trim() === want);
        if (!cands.length) return 'no-option:' + [...document.querySelectorAll('li')].map(e => (e.textContent || '').trim()).filter(Boolean).slice(0, 14).join('/');
        cands[0].click(); await sleep(6000);
        // 收起偏好面板（它半开着盖住左栏，出图难看）：先重查触发器点一次，不行就在地图上点一下
        const t2 = document.querySelector('[class*="preferenceTrigger"]') || document.querySelector('[class*="triggerLabel"]');
        try { (t2 || trig).click(); await sleep(900); } catch (e) {}
        const openNow = () => [...document.querySelectorAll('li,div,span,a')].some(e => !e.children.length && (e.textContent || '').trim() === want && e.getBoundingClientRect().height > 0);
        if (openNow()) {
          const mc = document.querySelector('.amap-container') || document.querySelector('#map');
          if (mc) {
            const r = mc.getBoundingClientRect(), cx = r.left + r.width * 0.78, cy = r.top + r.height * 0.55;
            for (const t of ['mousedown', 'mouseup', 'click']) mc.dispatchEvent(new MouseEvent(t, { bubbles: true, clientX: cx, clientY: cy }));
            await sleep(1000);
          }
        }
        if (openNow()) {   // 还不收起：直接把选项容器藏掉（它是 React 弹层，点外面不关）
          const lab = [...document.querySelectorAll('li,div,span,a')].find(e => !e.children.length && (e.textContent || '').trim() === want);
          let box = lab && lab.parentElement;
          for (let k = 0; k < 5 && box; k++) {
            const rc = box.getBoundingClientRect();
            if (rc.height >= 50 && rc.height <= 240 && rc.width >= 120 && rc.width <= 460) break;
            box = box.parentElement;
          }
          if (box) { box.style.display = 'none'; await sleep(400); }
        }
        const cs = [...document.querySelectorAll('[class*="routePlanItem"]')];
        return '偏好=' + want + '；面板' + (openNow() ? '未收起' : '已收起') + '；卡片 ' + cs.length + '：' + cs.map(c => (c.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 24)).join(' | ');
      })()`;
      try {
        await cmd('Runtime.enable');
        const r = await cmd('Runtime.evaluate', { returnByValue: true, expression: expr, awaitPromise: true });
        const v = r && r.result && (r.result.value !== undefined && r.result.value !== null ? r.result.value : r.result.description);
        console.log(`  偏好设置: ${String(v).slice(0, 400)}`);
      } catch (e) { console.log(`  偏好设置失败: ${String(e.message || e).slice(0, 200)}`); }
      await sleep(800);
    }
    // ── 只留一条路线（可选 --single [--pick N]）：高德网页版默认把备选路线
    //    一起画出来（同一张图三条线 + 三张卡片），交付图会很乱。
    //    实测：被选中的那条是品牌绿 #00C86E（层级最高），备选是 #9ADEC8。
    //    这里① 必要时切到第 N 张卡片 ② 隐掉其余路线折线 ③ 隐掉其余卡片。
    if (opt.single) {
      const pickIdx = Number.isFinite(opt.pick) ? opt.pick : 0;
      const expr = `(async () => {
        const sleep = ms => new Promise(r => setTimeout(r, ms));
        const cards = () => [...document.querySelectorAll('[class*="routePlanItem"]')];
        let cs = cards();
        if (!cs.length) return 'no-cards';
        if (${pickIdx} > 0 && cs[${pickIdx} - 1]) { cs[${pickIdx} - 1].click(); await sleep(3000); }
        const el = document.querySelector('.amap-container');
        const map = el && el.amap;
        let kept = 0, hidden = 0, sel = 0;
        if (map && map.getAllOverlays) {
          // 认线看颜色（比"点数多"稳）：选中＝品牌绿 #00C86E，备选＝浅绿 #9ADEC8；
          // 缓存的"底衬"是透明线、与主线点数相同。红/橙/青那些小折线是拥堵着色，别动。
          const pls = (map.getAllOverlays('polyline') || []);
          const colorOf = p => String(((p.getOptions && p.getOptions()) || {}).strokeColor || '').toLowerCase();
          const lenOf = p => ((p.getPath && p.getPath()) || []).length;
          const ROUTE = ['#00c86e', '#9adec8'];
          let chosen = pls.filter(p => colorOf(p) === '#00c86e');
          if (!chosen.length) {                       // 兜底：认不出品牌绿就留层级最高的实线
            const vis = pls.filter(p => ROUTE.indexOf(colorOf(p)) >= 0);
            if (vis.length) {
              const zOf = p => Number(((p.getOptions && p.getOptions()) || {}).zIndex) || 0;
              chosen = [vis.reduce((a, b) => (zOf(b) > zOf(a) ? b : a))];
            }
          }
          const lens = new Set(chosen.map(lenOf));
          for (const p of pls) {
            if (chosen.indexOf(p) >= 0 || lens.has(lenOf(p))) { kept++; continue; }   // 主线 + 它的底衬
            if (ROUTE.indexOf(colorOf(p)) >= 0) { if (p.hide) p.hide(); hidden++; }    // 备选路线
          }
          sel = chosen.length;
        }
        const list = cards();
        const keepAt = list.findIndex(c => /selected/.test(String(c.className)));
        let cardHidden = 0;
        list.forEach((c, i) => { if (i !== (keepAt < 0 ? 0 : keepAt)) { c.style.display = 'none'; cardHidden++; } });
        return '卡片 ' + list.length + '→留 ' + (list.length - cardHidden) + '；折线 留 ' + kept + ' / 隐 ' + hidden + '（选中线 ' + sel + '）';
      })()`;
      try {
        await cmd('Runtime.enable');
        const r = await cmd('Runtime.evaluate', { returnByValue: true, expression: expr, awaitPromise: true });
        const v = r && r.result && (r.result.value !== undefined && r.result.value !== null ? r.result.value : r.result.description);
        console.log(`  单线清理: ${String(v).slice(0, 300)}`);
      } catch (e) { console.log(`  单线清理失败: ${String(e.message || e).slice(0, 200)}`); }
      await sleep(700);
    }
    // ── 卡点标注（可选 --nodes）：支持「点」与「线」两种元素，画完再截图 ──
    // 点：{ label, lng, lat, level:high|mid|low }（可选 color；**编号默认不画**，要序号才 number:true）
    // 线（拥堵段）：{ type:"line", label, level 或 color, weight, points:[[lng,lat],…] }（可选 dash / badge:false 去掉编号圆点）
    // 顶层可以是数组，也可以是 { legendTitle, marks:[…] }（自定义图例标题）
    if (opt.nodes) {
      let raw;
      try { raw = JSON.parse(fs.readFileSync(opt.nodes, 'utf8').replace(/^\uFEFF/, '')); }
      catch (e) { console.error(`标注文件读取/解析失败: ${opt.nodes}（${e.code || e.message}）`); process.exit(1); }
      const nodes = Array.isArray(raw) ? raw : (raw.marks || []);
      if (!Array.isArray(nodes) || !nodes.length) {
        const hint = (!Array.isArray(raw) && Array.isArray(raw.nodes))
          ? '（看起来是 congestion-nodes.js 的产物：它是节点结论，不含 lng/lat/type/label，需先转成 marks）' : '';
        console.error(`标注文件里没有可用的 marks 数组: ${opt.nodes}${hint}`);
        process.exit(1);
      }
      // legend:false  → 不画菜单（客户口径：图上只留点＋引线＋名字）；
      // parallel:true → 引线**只走水平**、同一侧标注按 y 排成互不重叠的平行阶梯（南北走向路线用）。
      const showLegend = !(!Array.isArray(raw) && raw.legend === false);
      const parallelLbl = !Array.isArray(raw) && raw.parallel === true;
      const COLORS = { high: '#C62828', mid: '#F4511E', low: '#FF8A80' };
      const hasLine = nodes.some(n => n.type === 'line');
      const legendTitle = (!Array.isArray(raw) && raw.legendTitle)
        || (nodes.some(n => n.color) ? '标注' : (hasLine ? '拥堵段（线）与卡点（点）' : '拥堵卡点严重度'));
      const expr = `(() => {
        const el = document.querySelector('.amap-container');
        const map = el && el.amap;
        if (!map || !window.AMap) return 'no-map';
        const list = ${JSON.stringify(nodes)};
        const col = ${JSON.stringify(COLORS)};
        const SHOW_LEGEND = ${JSON.stringify(showLegend)};
        const PARALLEL = ${JSON.stringify(parallelLbl)};
        const rect = el.getBoundingClientRect();
        const W = window.innerWidth, H = window.innerHeight;
        // ① 算出左侧「路线面板」的右边缘 —— 标注/图例不能压到面板下面（按位置+尺寸找，别只靠文字）
        let panelRight = 0;
        try {
          const all = [...document.querySelectorAll('div,section,aside,ul')];
          for (const d of all) {
            const r = d.getBoundingClientRect();
            if (r.left > 20 || r.width < 200 || r.width > 540 || r.height < 240) continue;
            if (!/偏好|途经|详情|公里/.test(d.textContent || '')) continue;
            panelRight = Math.max(panelRight, r.right);
          }
        } catch (e) {}
        const SAFE_L = (panelRight > 120 ? panelRight : 0) + 6;
        const toPx0 = ll => { const c = map.lngLatToContainer(ll); return [rect.left + c.x, rect.top + c.y]; };
        // ② 路线几何（像素）：**标签和图例都要避开它**——实测图例压在下半屏，
        //    正好把高速段盖住，客户第一反应是"路线图被注释挡住了"。
        const routePts = [];
        list.forEach(n => {
          if (n.type === 'line' && Array.isArray(n.points)) n.points.forEach((p, i) => { if (i % 2 === 0) routePts.push(toPx0(p)); });
          else if (n.lng != null && n.lat != null) routePts.push(toPx0([n.lng, n.lat]));
        });
        // ②′ 地图上**真实折线**（路线本体）也是障碍：优先问 AMap 拿 overlay 折线路径，
        //    拿不到再退回去采样 SVG path。只拿标注自身坐标当障碍不够用——客户反复强调"注释不能挡住路线图"。
        try {
          for (const o of (map.getAllOverlays ? (map.getAllOverlays('polyline') || []) : [])) {
            try { if (o.getVisible && o.getVisible() === false) continue; } catch (e) {}
            const path = (o.getPath && o.getPath()) || [];
            const step = Math.max(1, Math.floor(path.length / 400));
            for (let i = 0; i < path.length; i += step) {
              const q = path[i]; if (!q) continue;
              const ll = (q.lng != null) ? [q.lng, q.lat] : q;
              if (ll[0] == null) continue;
              routePts.push(toPx0(ll));
            }
          }
        } catch (e) {}
        try {
          for (const p of [...el.querySelectorAll('svg path')]) {
            let len = 0; try { len = p.getTotalLength(); } catch (e) { continue; }
            if (!(len > 40)) continue;
            const bb = p.getBoundingClientRect();
            if (bb.width < 24 && bb.height < 24) continue;
            const m = p.getScreenCTM(); if (!m) continue;
            const step = Math.max(7, len / 90);
            for (let d = 0; d <= len && routePts.length < 4000; d += step) {
              try { const q = p.getPointAtLength(d).matrixTransform(m); routePts.push([q.x, q.y]); } catch (e) {}
            }
          }
        } catch (e) {}
        const placed = [];
        // ②″ 地图自己的**控件/气泡**（天气、缩放、"全国"搜索框、比例尺…）也不能压：
        //     它们是有文字的 DOM 元素，量出矩形当障碍（底图城市名是 canvas，量不到，只能让步）。
        const uiRects = [];
        try {
          for (const d of document.querySelectorAll('.amap-container *')) {
            const r = d.getBoundingClientRect();
            if (r.width < 24 || r.height < 14 || r.width > 460 || r.height > 130) continue;
            if (!(d.textContent || '').trim()) continue;
            uiRects.push([r.left, r.top, r.right, r.bottom]);
          }
        } catch (e) {}
        let badLbl = 0;
        const inRect = (p, x, y, w, h) => p[0] >= x && p[0] <= x + w && p[1] >= y && p[1] <= y + h;
        const score = (x, y, w, h) => {
          if (x < SAFE_L || y < 6 || x + w > W - 8 || y + h > H - 8) return 1e6;      // 出界 / 压面板
          let s = 0;
          for (const p of routePts) if (inRect(p, x, y, w, h)) s += 4;                 // 压路线：最重
          for (const r of placed) if (!(x + w < r.x || x > r.x + r.w || y + h < r.y || y > r.y + r.h)) s += 60;
          for (const r of uiRects) if (!(x + w < r[0] || x > r[2] || y + h < r[1] || y > r[3])) s += 200;  // 压地图控件
          return s;
        };
        const why = (x, y, w, h) => { let rp = 0, lp = 0; for (const p of routePts) if (inRect(p, x, y, w, h)) rp++;
          for (const r of placed) if (!(x + w < r.x || x > r.x + r.w || y + h < r.y || y > r.y + r.h)) lp++; return 'r' + rp + 'l' + lp; };
        function putLabel(text, px, py, accent) {
          const w = Math.min(320, text.replace(/[\\u4e00-\\u9fa5]/g, 'aa').length * 7 + 18), h = 21;
          // 候选位：以锚点为中心**由近及远**铺开（左右各几档 + 上下各几档）
          const offs = [];
          for (const d of [26, 52, 86, 126, 172, 224]) offs.push([d, -11], [-w - d, -11], [d, 6], [-w - d, 6]);
          for (const d of [30, 54, 82, 116, 156]) offs.push([-w / 2, -d], [-w / 2, d - h + 6]);
          const hits = (x, y) => {
            let rp = 0, lo = 0, ui = 0;
            for (const p of routePts) if (inRect(p, x, y, w, h)) rp++;
            for (const r of placed) if (!(x + w < r.x || x > r.x + r.w || y + h < r.y || y > r.y + r.h)) lo++;
            for (const r of uiRects) if (!(x + w < r[0] || x > r[2] || y + h < r[1] || y > r[3])) ui++;
            return { rp, lo, ui };
          };
          const cands = [];
          for (const o of offs) {
            const x = Math.max(SAFE_L, Math.min(px + o[0], W - w - 8));
            const y = Math.max(6, Math.min(py + o[1], H - h - 8));
            const t = hits(x, y);
            cands.push({ x, y, rp: t.rp, lo: t.lo, ui: t.ui, d: Math.abs(x + w / 2 - px) + Math.abs(y + h / 2 - py) });
          }
          // 只要"不压路线、不压别家标注、不压地图控件"里**最近**的那一个；
          // 实在找不到，才退而求其次（少压一点、尽量近）——以前用加权分，标签会飞到很远的空地去。
          const clean = cands.filter(c => c.rp === 0 && c.lo === 0 && c.ui === 0).sort((a, b) => a.d - b.d);
          const soft = cands.filter(c => c.lo === 0).sort((a, b) => (a.rp + a.ui * 2) - (b.rp + b.ui * 2) || a.d - b.d);
          const last = cands.slice().sort((a, b) => (a.rp + a.lo * 8 + a.ui * 2) - (b.rp + b.lo * 8 + b.ui * 2) || a.d - b.d);
          const pick = clean[0] || soft[0] || last[0];
          const x = pick.x, y = pick.y;
          if (!(pick.rp === 0 && pick.lo === 0 && pick.ui === 0)) badLbl++;   // 记一笔：这条标注没能放进"干净位"
          placed.push({ x, y, w, h, k: 'L' });
          const d = document.createElement('div');
          d.style.cssText = 'position:fixed;left:' + x + 'px;top:' + y + 'px;z-index:99998;background:rgba(255,255,255,.94);color:' +
            (accent ? '#B71C1C' : '#222') + ';border:1px solid ' + (accent || '#d6d6d6') + ';border-radius:4px;padding:1px 7px;font:12px/17px system-ui,-apple-system,sans-serif;white-space:nowrap';
          d.textContent = text;
          document.body.appendChild(d);
          return { x, y };
        }
        // 编号圆点：**默认不画**（客户口径 2026-10-17：拥堵段＝红点＋水平引线、不再涂线色；节点图里卡点也不加编号圆点）；只有 badge:true 时才贴在"被标的东西"上
        function putBadge(text, px, py, color) {
          const s = 19;
          const d = document.createElement('div');
          d.style.cssText = 'position:fixed;left:' + (px - s / 2) + 'px;top:' + (py - s / 2) + 'px;width:' + s + 'px;height:' + s +
            'px;line-height:' + s + 'px;text-align:center;border-radius:50%;background:' + color +
            ';color:#fff;font:700 12px/19px system-ui,-apple-system,sans-serif;border:2px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,.35);z-index:99999';
          d.textContent = text;
          document.body.appendChild(d);
          placed.push({ x: px - s / 2, y: py - s / 2, w: s, h: s, k: 'B' });
        }
        // 引线：把圆点和名字连起来（客户口径：**充电位要"拉出一条线引出服务区名字"**）
        function leader(px, py, x, y, color) {
          const ex = x < px ? x + 6 : x, ey = y + 10;
          if (Math.abs(px - ex) < 8 && Math.abs(py - ey) < 8) return;
          const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
          svg.setAttribute('style', 'position:fixed;inset:0;width:100%;height:100%;z-index:99997;pointer-events:none');
          const ln = document.createElementNS('http://www.w3.org/2000/svg', 'line');
          ln.setAttribute('x1', px); ln.setAttribute('y1', py); ln.setAttribute('x2', ex); ln.setAttribute('y2', ey);
          ln.setAttribute('stroke', color || '#888'); ln.setAttribute('stroke-width', '1.4'); ln.setAttribute('stroke-dasharray', '4 2');
          svg.appendChild(ln); document.body.appendChild(svg);
        }
        const toPx = ll => { const c = map.lngLatToContainer(ll); return [rect.left + c.x, rect.top + c.y]; };
        // ③ 图例（＝客户说的"菜单"）：**先摆菜单、再摆标注**——菜单只有四个角可选，
        //    标注候选位多得多；反过来（先摆标注）菜单会被逼到压标注的角上。
        const lg = document.createElement('div');
        let lw = 0, lh = 0, ls = 0, dbg = [];
        if (SHOW_LEGEND) {
        lg.style.cssText = 'position:fixed;left:-9999px;top:0;z-index:99999;background:rgba(255,255,255,.93);border:1px solid #e2e2e2;border-radius:10px;padding:7px 10px;font:11.5px/1.55 system-ui,-apple-system,sans-serif;box-shadow:0 3px 12px rgba(0,0,0,.15);color:#222;max-width:' + Math.min(336, Math.max(200, W - SAFE_L - 40)) + 'px;visibility:hidden';
        const sw = n => (n.type === 'sep') ? ''
          : (n.type === 'line')
          ? '<span style="display:inline-block;width:15px;height:5px;border-radius:3px;background:' + (n.color || col[n.level] || col.high) + ';margin-right:7px;vertical-align:2px"></span>'
          : '<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:' + (n.color || col[n.level] || col.mid) + ';margin-right:7px;vertical-align:-1px"></span>';
        lg.innerHTML = '<div style="font-weight:700;margin-bottom:4px">' + ${JSON.stringify(legendTitle)} + '</div>' +
          list.map(n => n.type === 'sep'
            ? '<div style="margin:6px 0 2px;padding-top:4px;border-top:1px solid #e6e6e6;font-weight:700">' + (n.legendLabel || n.label) + '</div>'
            : '<div>' + sw(n) + (n.legendLabel || n.label || '') + '</div>').join('') +
          '<div style="margin-top:4px;padding-top:4px;border-top:1px dashed #dcdcdc;color:#5a5a5a;font-size:10.5px">底图与图上实线＝地图自己算路绘制；红／蓝点、引线与名字＝本报告加的标注；<b>底图上金色／彩色小圆点＝高德自带的设施图标（服务区、加油站等），不是本报告的标注</b></div>';
        document.body.appendChild(lg);
        lw = lg.offsetWidth; lh = lg.offsetHeight;
        const cand = [[SAFE_L + 6, 52], [W - lw - 14, 52], [SAFE_L + 6, H - lh - 34], [W - lw - 14, H - lh - 34],
                      [SAFE_L + 6, H - lh - 10], [W - lw - 14, H - lh - 10]];
        let lb = cand[0];
        ls = Infinity;
        dbg = [];
        for (const c of cand) { const s = score(c[0], c[1], lw, lh); dbg.push('(' + Math.round(c[0]) + ',' + Math.round(c[1]) + ')=' + s + why(c[0], c[1], lw, lh)); if (s < ls) { ls = s; lb = c; } }
        lg.style.left = lb[0] + 'px'; lg.style.top = lb[1] + 'px'; lg.style.visibility = 'visible';
        placed.push({ x: lb[0], y: lb[1], w: lw, h: lh, k: 'G' });
        }
        // ⑧ 平行引线模式（parallel:true）：南北走向的路线，标注一律放东西两侧，
        //    引线**纯水平**、同一侧的标注按 y 排序后按"阶梯"互不重叠；名取 n.label。
        function putParallelAll(list, toPx) {
          const GAP = 26, LH = 21;
          const items = [];
          list.forEach((n, idx) => {
            if (!n.label || n.labelOnMap === false || n.type === 'sep' || n.type === 'line') return;   // 线没有 lng/lat，不能进平行标注
            const probe = document.createElement('div');
            probe.style.cssText = 'position:fixed;left:-9999px;top:0;z-index:99998;background:rgba(255,255,255,.94);border:1px solid #d6d6d6;border-radius:4px;padding:1px 7px;font:12px/17px system-ui,-apple-system,sans-serif;white-space:nowrap';
            probe.textContent = n.label;
            document.body.appendChild(probe);
            const w = probe.offsetWidth || 60;
            probe.remove();
            items.push({ idx, w, text: n.label, n });
          });
          const valid = items.filter(it => Number.isFinite(it.n.lng) && Number.isFinite(it.n.lat));
          valid.forEach(it => {
            const p = toPx([it.n.lng, it.n.lat]);
            it.px = p[0]; it.py = p[1];
            it.side = (it.n.labelDir === 'w' || it.n.labelDir === 'W') ? 'w' : 'e';
          });
          items.length = 0; valid.forEach(it => items.push(it));   // 无坐标的点不进平行队列（否则投影成 undefined）
          const sides = { w: [], e: [] };   // 每侧：lanes[k] = { x0..x1(相对路线), maxW, boxes[] }
          const out = [];
          for (const side of ['w', 'e']) {
            const arr = items.filter(it => it.side === side).sort((a, b) => a.py - b.py);
            const lanes = [];
            for (const it of arr) {
              // 选一条"竖直方向不撞"的阶梯；没有就新开一条
              let k = -1;
              for (let i = 0; i < lanes.length; i++) {
                if (lanes[i].every(b => Math.abs(b.py - it.py) >= LH + 3)) { k = i; break; }
              }
              if (k < 0) { lanes.push([]); k = lanes.length - 1; }
              lanes[k].push(it);
              it.lane = k;
            }
            const maxW = lanes.map(l => Math.max(0, ...l.map(it => it.w)));
            let off = 0;
            const offs = [];
            for (let k = 0; k < lanes.length; k++) { offs[k] = off; off += maxW[k] + 14; }
            for (const it of lanes.flat()) {
              let x = side === 'w' ? it.px - GAP - it.w - offs[it.lane] : it.px + GAP + offs[it.lane];
              const y = it.py - Math.round(LH / 2);
              // 标签落在"安全区"外/越界时，往路线内侧再退一档（仍是水平引线）
              const clippedL = x < SAFE_L + 4, clippedR = x + it.w > W - 8;
              if (clippedL || clippedR) x = side === 'w' ? SAFE_L + 4 : W - 8 - it.w;
              // 最后一道保险：别压到路线（把标签再往外推 GAP 的整数倍）
              let tries = 0, bx = x;
              // 推完后必须再夹回安全区（否则标签会被推出画布/压到左侧面板，而四数仍全 0）
              const box = { x: bx, y, w: it.w, h: LH };
              while (tries < 5 && routePts.some(p => inRect(p, bx, y, it.w, LH))) {
                bx = side === 'w' ? bx - 16 : bx + 16; tries++;
              }
              bx = Math.max(SAFE_L + 4, Math.min(bx, W - 8 - it.w));
              if (bx <= SAFE_L + 4 || bx >= W - 8 - it.w) badLbl++;
              out.push({ box: { x: bx, y, w: it.w, h: LH }, px: it.px, py: it.py, side, color: (it.n.color || col[it.n.level] || col.mid), text: it.text });
            }
          }
          // 统一落 DOM：标签 → 引线 → 登记 placed（参与"互压/压线"统计）
          for (const o of out) {
            const d = document.createElement('div');
            d.style.cssText = 'position:fixed;left:' + o.box.x + 'px;top:' + o.box.y + 'px;z-index:99998;background:rgba(255,255,255,.94);color:#222;border:1px solid #d6d6d6;border-left:3px solid ' + o.color + ';border-radius:4px;padding:1px 7px;font:12px/17px system-ui,-apple-system,sans-serif;white-space:nowrap';
            d.textContent = o.text;
            document.body.appendChild(d);
            placed.push({ x: o.box.x, y: o.box.y, w: o.box.w, h: o.box.h, k: 'L' });
            const x1 = o.side === 'w' ? o.px - 8 : o.px + 8;
            const x2 = o.side === 'w' ? o.box.x + o.box.w : o.box.x;
            if (Math.abs(x2 - x1) >= 6) {
              const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
              svg.setAttribute('style', 'position:fixed;inset:0;width:100%;height:100%;z-index:99997;pointer-events:none');
              const ln = document.createElementNS('http://www.w3.org/2000/svg', 'line');
              ln.setAttribute('x1', x1); ln.setAttribute('y1', o.py); ln.setAttribute('x2', x2); ln.setAttribute('y2', o.py);
              ln.setAttribute('stroke', o.color); ln.setAttribute('stroke-width', '1.4'); ln.setAttribute('stroke-dasharray', '4 2');
              svg.appendChild(ln); document.body.appendChild(svg);
            }
          }
          return out.length;
        }
        const parallelCount = PARALLEL ? putParallelAll(list, toPx) : 0;
        const CIRC = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩'];
        let ptNo = 0;
        list.forEach((n, idx) => {
          const c = n.color || col[n.level] || col.mid;
          if (n.type === 'sep') return;   // 图例分隔/小标题行：只在图例里出现，地图上不画
          if (n.type === 'line' && Array.isArray(n.points) && n.points.length > 1) {
            new AMap.Polyline({ path: n.points.map(p => [p[0], p[1]]), strokeColor: c,
              strokeWeight: n.weight || 8, strokeOpacity: (n.opacity != null ? n.opacity : 0.85), lineJoin: 'round', lineCap: 'round',
              strokeStyle: n.dash ? 'dashed' : 'solid', zIndex: 260 }).setMap(map);
            // 拥堵段**默认不标点**（客户口径：只在地图上涂颜色，说明进"菜单"图例）；
            // 确实要在线上打个编号圆点时才写 badge:true。
            const m = String(n.label || '').match(/^([①②③④⑤⑥⑦⑧⑨⑩])/);
            if (n.badge === true) {
              const mid = n.points[Math.floor(n.points.length / 2)];
              const p = toPx([mid[0], mid[1]]);
              putBadge(m ? m[1] : CIRC[idx] || String(idx + 1), p[0], p[1], c);
            }
            return;
          }
          const r = n.r != null ? n.r : (n.level === 'high' ? 11 : n.level === 'mid' ? 9 : 7);
          // 用**DOM Marker**而不是 CircleMarker：CircleMarker 画在矢量层，会被高德的
          // 地名/POI 标签层压住（实测衡水段、广州段的红点被「石家庄」「广州」文字盖掉）。
          const sz = r * 2 + 4;   // 留出 2px 白描边的位置（内芯仍是 2r，跟 CircleMarker 观感一致）
          new AMap.Marker({
            position: [n.lng, n.lat],
            offset: new AMap.Pixel(-r, -r),
            zIndex: 300,
            content: '<div style="width:' + sz + 'px;height:' + sz + 'px;border-radius:50%;background:' + c +
              ';border:2px solid #fff;box-sizing:border-box;box-shadow:0 1px 3px rgba(0,0,0,.35)"></div>',
          }).setMap(map);
          if (!PARALLEL && n.number === true) {   // 编号默认不画（客户口径：图上不要编号）；要点序号才 number:true
            ptNo += 1;
            new AMap.Text({ text: String(ptNo), position: [n.lng, n.lat], offset: new AMap.Pixel(-6, -9),
              style: { background: c, color: '#fff', border: 'none', 'font-size': '11px', 'font-weight': '700',
                padding: '1px 5px', 'border-radius': '9px', 'line-height': '14px' }, zIndex: 400 }).setMap(map);
          }
          if (n.label && n.labelOnMap !== false) {
            // 平行模式已在 putParallelAll 里统一摆好（名字＋水平引线），这里不再重复
            if (PARALLEL) return;
            // 点标注：紧贴自己的点（候选位按"由近到远"试），偏远时连一条引线
            const p = toPx([n.lng, n.lat]);
            const box = putLabel(n.label, p[0], p[1], null);
            leader(p[0], p[1], box.x, box.y, c);
          }
        });
        const hitLbl = placed.filter(r => r.k === 'L' && (routePts.some(p => inRect(p, r.x, r.y, r.w, r.h)) || r.x < SAFE_L || r.x + r.w > W - 4 || uiRects.some(u => !(r.x + r.w < u.x || r.x > u.x + u.w || r.y + r.h < u.y || r.y > u.y + u.h)))).length;
        let hitLbl2 = 0;
        for (let i = 0; i < placed.length; i++) for (let j = i + 1; j < placed.length; j++) {
          const a = placed[i], b = placed[j];
          if (!(a.x + a.w < b.x || a.x > b.x + b.w || a.y + a.h < b.y || a.y > b.y + b.h)) hitLbl2++;
        }
        return 'ok:' + list.length + ' panelRight=' + Math.round(panelRight) + ' 压线分=' + ls + ' 图例=' + (SHOW_LEGEND ? Math.round(lw) + 'x' + Math.round(lh) : 'off') + ' 平行引线=' + parallelCount + ' 候选[' + dbg.join(' ') + '] 路线点数=' + routePts.length + ' 地图控件=' + uiRects.length + ' 标注压线=' + hitLbl + ' 标注互压=' + hitLbl2 + ' 标注退让=' + badLbl;
      })()`;
      const nr = await cmd('Runtime.evaluate', { returnByValue: true, expression: expr });
      const annStr = nr && nr.result && typeof nr.result.value === 'string' ? nr.result.value : null;
      if (!annStr) throw new Error('标注脚本执行失败，四项验收值缺失：' + JSON.stringify(nr).slice(0, 500));
      console.log(`  卡点标注: ${annStr}`);
      await sleep(1200);
    }
    const shotRes = await cmd('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.mkdirSync(path.dirname(path.resolve(outPng)), { recursive: true });
    fs.writeFileSync(outPng, Buffer.from(shotRes.data, 'base64'));
    return { file: outPng, bytes: fs.statSync(outPng).size, size: `${W * SCALE}x${H * SCALE}` };
  } finally {
    try { ws && ws.close(); } catch {}
    try { child.kill(); } catch {}
    await sleep(600);
    try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
    try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch {}
  }
}

// ── CLI ──────────────────────────────────────────────────────────────────────
const HELP = `map-shot.js —— 自驾路线规划出图（高德链接 + 无头截图）

用法:
  node scripts/map-shot.js link <points.json> [--out <file>] [--pretty]
      生成：① 高德网页版链接（免 key，via[i] 多途经点，实测 10 个可用）
            ② 高德 App scheme（Android amapuri:// / iOS iosamap://，vian+vialons/vialats/vianames）
      --out 落盘；--pretty 只打印、不写盘

  node scripts/map-shot.js shot <url> <out.png> [--wait 24000] [--w 1400] [--h 900] [--scale 2] [--nodes nodes.json] [--single [--pick N]] [--pref "<偏好名>"] [--click x,y] [--js inject.js]
       --nodes 标注（客户口径 2026-10-17：**总览图只留「点 ＋ 引线 ＋ 名字」**）
              拥堵段＝主线上一个**红点**（大概位置）＋**水平引线**引出段名；电车充电＝**蓝点**＋水平引线引出服务区名；
              **图上不要菜单 / 表格 / 编号 / 线色涂段**（客户：「拥堵路段…只要在总览图里涂上拥堵路线颜色就行了」→ 现改为红点）
              开关写在 JSON 顶层对象：{ "legend": false, "parallel": true, "marks": [ … ] }
                legend:false   → 不画菜单（总览图用；节点图保留菜单时省略）
                parallel:true  → 南北走向路线专用：引线**只走水平**、同侧标注按 y 排成互不重叠的平行阶梯；
                                 每个点用 labelDir:"w"|"e" 指定放路线哪一侧（拥堵段名 w 侧、服务区名 e 侧）
              点用 **DOM AMap.Marker** 渲染（不用 CircleMarker）：CircleMarker 在矢量层会被高德地名层压住
              （实测红点被「石家庄」「广州」等文字盖掉）
              JSON 顶层是数组，或 { "legendTitle": "…", "marks": [ … ] }
              线：默认**不画编号圆点、地图上不写名字**；要圆点才写 badge:true
              点：默认「小圆点 + 引线 + 名字标签」；label＝地图上的名字，legendLabel＝菜单里的长名（只在出菜单时用）
              线可选 dash:true、opacity；点可选 number:true（画序号，**默认不画**）、labelOnMap:false、r:7、labelDir:"w"|"e"
          分隔行：{ "type":"sep", "label":"…" } —— 只在菜单里出一行小标题
         线：{ "type":"line", "level":"high|mid|low"（或 "color":"#C62828"）, "label":"…", "weight":10, "opacity":0.72, "dash":false, "points":[[lng,lat],…] }
         点：{ "label":"深州服务区", "legendLabel":"1 深州服务区（广州方向）231 km", "lng":…, "lat":…, "color":"#1E88E5", "r":7 }
       level 即严重度：high 深红 / mid 红 / low 浅红（判定口径见 references/driving-route-planning.md §1 ⑤″）
       ⚠ 点要先投影到路线折线上再写进 JSON，否则会跑到线外
      无头 Edge + CDP：导航 → 等地图渲染 → 关登录浮层（Esc，可用 --click 点掉关闭按钮）→ 截图
       --js <file>：页面加载完后注入一段 JS（截图前执行），返回值打印出来——
                    用途是把界面收拾干净，例如用「偏好」把备选路线筛掉、只留我们选定的那条
       --single：**只留一条路线**（默认的推荐那条）。高德网页版会把备选路线一起画出来
                 （同一张图三条线 + 三张卡片），交付图很乱；这一项会隐掉其余折线与卡片。
       --pick N：先切到第 N 张**路线卡片**（列表从上到下数，N 从 1 起），再清理；不给＝保留默认选中那条（「偏好」筛选用 --pref）
       --pref <文字>：点开页面上的「偏好」，选里面那一条（例如 --pref 不走高速 让**地图自己**
                 按地面路算路并画线）。⚠ 实测 **URL 参数 policy=3 在网页版会被忽略**（照样给高速），
                 要"不走高速"必须走这一项；它要在 --single 之前生效，两项一起用。
       **标注摆放**：**菜单先摆、标注后摆**；标签、引线、菜单都**避开路线几何**（压线权重最高，
                 障碍点从地图上真实折线采样、另把地图控件矩形当障碍）、**互不重叠**、不压左侧路线面板；
                 菜单在四个角里挑最干净的那个，并在末行注明"底图与实线＝地图画的、红绿虚线＝本报告标注"，
                 **外加一句"底图上金色／彩色小圆点＝高德自带设施图标（服务区、加油站等），不是本报告标注"**
                 —— 底图 POI 图标画在 map 的 canvas 上（用 --js 探过：命中只有 CANVAS.amap-layer），
                 DOM 删不掉，只能在菜单里声明，免得客户把它当成我们的标注。
       截图时会打印 **标注压线 / 标注互压 / 标注退让 / 压线分**——**交付前这四个数必须全是 0**。
      **截图即交付物**；必须保留页面上的 © 高德 版权信息，不得裁掉。

  node scripts/map-shot.js selfcheck     # 不联网：校验坐标系转换与链接拼装

points.json:
  { "from": {"name":"福州","lng":119.2965,"lat":26.0745},
    "to":   {"name":"田东","lng":107.1261,"lat":23.6001},
    "policy": 0,                      // 0 推荐(默认全程高速) / 1 避免拥堵 / 2 避免收费
                                      // ⚠ 3「不走高速」在网页版**被忽略**（照样给高速）——要地面路线用 shot 的 --pref 不走高速
    "coord": "gcj02",                 // gcj02 / wgs84(自动转；出图只用高德)
    "vias": [ {"name":"三明","lng":117.6389,"lat":26.2637}, … ] }

合规（硬性）: 截图仅供客户本人查看，保留版权号；不得公开再分发/商用。对外分发请改用 OSM（ODbL，需署名）底图。
依赖: Node ≥ 21、本机 Microsoft Edge；不需要任何 key。
`;
function parseFlags(argv) {
  const o = { wait: 24000, w: 1400, h: 900, scale: 2, out: null, pretty: false, click: null, nodes: null, js: null, single: false, pick: 0, pref: null };
  const need = (i, name) => {
    const v = argv[i + 1];
    if (v === undefined || String(v).startsWith('--')) { console.error(`参数 ${name} 缺少取值（--help 看用法）`); process.exit(1); }
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') o.out = need(i++, '--out');
    else if (a === '--wait') o.wait = Math.max(3000, Number(need(i++, '--wait')) || 24000);
    else if (a === '--w') o.w = Number(need(i++, '--w')) || 1400;
    else if (a === '--h') o.h = Number(need(i++, '--h')) || 900;
    else if (a === '--scale') o.scale = Number(need(i++, '--scale')) || 2;
    else if (a === '--click') {
      const p = String(need(i++, '--click')).split(',').map(Number);
      if (p.length < 2 || p.some(n => !Number.isFinite(n))) { console.error('--click 需要 x,y 两个数字'); process.exit(1); }
      o.click = [p[0], p[1]];
    }
    else if (a === '--nodes') o.nodes = need(i++, '--nodes');
    else if (a === '--js') o.js = need(i++, '--js');
    else if (a === '--single') o.single = true;
    else if (a === '--pick') o.pick = Number(need(i++, '--pick')) || 0;
    else if (a === '--pref') o.pref = need(i++, '--pref');
    else if (a === '--pretty') o.pretty = true;
    else if (a.startsWith('--')) { console.error(`未知参数: ${a}（--help 看用法）`); process.exit(1); }
  }
  return o;
}
(async () => {
  const argv = process.argv.slice(2);
  if (!argv.length || argv.includes('--help') || argv.includes('-h')) { process.stdout.write(HELP); process.exit(0); }
  const mode = argv[0], opt = parseFlags(argv.slice(1));
  if (mode === 'link') {
    const file = argv[1];
    if (!file) { console.error('用法: map-shot.js link <points.json> [--out <file>]'); process.exit(1); }
    let d;
    try { d = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
    catch (e) { console.error(`数据文件读取/解析失败: ${file}（${e.code || e.message}）`); process.exit(1); }
    let r;
    try { r = buildLinks(d); } catch (e) { console.error('数据错误: ' + String((e && e.message) || e)); process.exit(1); }
    const text = [`# 高德网页版（免 key，PC/手机通用）  ${r.urlLen} 字符`,
      r.web, '', '# Android（App 唤起，sourceApplication 必填）', r.android, '', '# iOS（App 唤起）', r.ios,
      '', `# 途经点 ${r.vias} 个 · 坐标系 ${r.coord} · policy=${r.policy}（0=推荐/默认全程高速）`,
      ...r.warn.map(w => '⚠ ' + w)].join('\n') + '\n';
    if (opt.pretty || !opt.out) process.stdout.write(text);
    if (opt.out) { fs.writeFileSync(opt.out, text, 'utf8'); console.log(`已写出 ${opt.out}`); }
    process.exit(0);
  }
  if (mode === 'shot') {
    const [, url, out] = argv;
    // 两个参数都是位置参数（第二个就是输出文件），误加 --out 会把 "--out" 当成文件名写到当前目录
    if (out && /^-/.test(String(out))) {
      console.error('输出路径被写成了选项（"' + out + '"）——shot 的第二个参数就是文件名：node scripts/map-shot.js shot <url> <out.png>');
      process.exit(1);
    }
    if (url && !/^https?:\/\//i.test(String(url))) {
      console.error('第一个参数必须是 http(s) 链接（当前是 "' + url + '"）——先用 map-shot.js link <points.json> 生成链接，再 shot 那个链接。');
      process.exit(1);
    }
    if (!url || !out) { console.error('用法: map-shot.js shot <url> <out.png> [--wait ms] [--w px] [--h px] [--scale n] [--nodes json] [--single [--pick N]] [--pref 偏好名] [--click x,y] [--js file]'); process.exit(1); }
    try {
      const r = await shot(url, out, opt);
      console.log(`已截图: ${r.file}  (${(r.bytes / 1024).toFixed(0)} KB, ${r.size})`);
      console.log('⚠ 保留 © 高德 版权信息、仅供客户本人查看，不得公开再分发或商用。');
      process.exit(0);
    } catch (e) {
      const dataErr = /^(数据|标注)/.test(e.message);
      console.error((dataErr ? '数据错误: ' : '截图失败: ') + e.message);
      process.exit(dataErr ? 1 : 2);
    }
  }
  if (mode === 'selfcheck') {
    const a = toGcj({ lng: 116.3975, lat: 39.9087 }, 'wgs84');
    const b = toGcj({ lng: 116.3975, lat: 39.9087 }, 'gcj02');
    const ok = (v) => Number.isFinite(v[0]) && Number.isFinite(v[1]);
    const inCN = [a, b].every(ok);
    const shifted = Math.hypot(a[0] - b[0], a[1] - b[1]) > 0.001;   // WGS→GCJ 必须有偏移
    let rejected = false;
    try { toGcj({ lng: 116.4, lat: 39.9 }, 'unknown'); } catch { rejected = true; }   // 未知坐标系必须被拒
    console.log(`WGS84→GCJ02: ${a[0].toFixed(6)},${a[1].toFixed(6)}`);
    console.log(`GCJ02 原样  : ${b[0].toFixed(6)},${b[1].toFixed(6)}`);
    console.log(`未知坐标系  : ${rejected ? '已拒绝' : '未被拒绝 ✗'}`);
    const r = buildLinks({ from: { name: '福州', lng: 119.2965, lat: 26.0745 }, to: { name: '田东', lng: 107.1261, lat: 23.6001 }, coord: 'gcj02', vias: [{ name: '三明', lng: 117.6389, lat: 26.2637 }] });
    const linkOk = r.web.includes('via[0][lnglat]=117.6389,26.2637') && r.android.includes('vian=1') && r.ios.startsWith('iosamap://path?');
    console.log(`链接拼装: web ${r.urlLen} 字符 / android vian=${r.android.match(/vian=(\d+)/)?.[1]} / ios 前缀 ${r.ios.slice(0, 16)}`);
    const pass = inCN && shifted && linkOk && rejected;
    console.log(pass ? 'selfcheck PASS' : 'selfcheck FAIL');
    process.exit(pass ? 0 : 1);
  }
  console.error('未知子命令: ' + mode + '（可用 link / shot / selfcheck / --help）');
  process.exit(1);
})();
