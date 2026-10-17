#!/usr/bin/env node
/**
 * travel 行程文档生成器（HTML 唯一出口，禁止手写生成脚本）
 *
 * 用法:
 *   node scripts/make_html.js plan  <data.json> <out.html>   # 流程一：交通方案
 *   node scripts/make_html.js spots <data.json> <out.html>   # 流程二：景点推荐
 *   node scripts/make_html.js itin  <data.json> <out.html>   # 流程二：行程方案
 *
 * 设计目标 = 屏幕（网页），不是 A4 纸面：
 *   - 单文件、零依赖、零外链：双击即用浏览器打开，无 CDN、无字体下载、无图片文件
 *   - 满宽布局（max-width 1180px）+ 放大字号（正文 17px / 时刻 20px / 章节 28px / 主标题 44px）
 *   - 用足横向空间：方案页「时间线 + 费用卡」两栏；景点页「好评/差评/我的点评」三栏；
 *     逐段页两列网格；方案对比三栏
 *   - 左侧目录 + 锚点跳转（网页特有；窄屏自动折叠为可展开的"目录"）
 *   - 容器查询做响应式：宽屏多栏、窄屏自动重排为单栏（手机可读）
 *
 * 交付形态 = 单文件 HTML：本技能**不产出 PDF**（客户要纸面时自行用浏览器打印，
 * 打印版面由 check_html.js 的「A4 纸宽实测」兜住）。
 * 生成后仍须过「HTML 出品校验」（scripts/check_html.js）。
 */

'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
// 写盘前先建父目录（实测：输出目录不存在时直接 ENOENT，执行者得先建目录再重跑一次）
function ensureDir(file) { try { fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true }); } catch { /* 真写不进去会在 writeFileSync 报错 */ } }
// 校验规则与几个共用小工具**只在 lib/validate.js 里实现一份**——
// 同一套规则还要被 scripts/spots_check.js（预研门禁）复用，写两份必然漂移。
const { validateData, stripLead, legNo, card3, kmText } = require('./lib/validate');

// ---------- 口径（与 SKILL.md「方案生成」「席别规则」一致）----------
// 过夜 / 住宿 / **跨天到达**类信息命中即标红
// —— 「次日」「(+1天)」「翌日」也算：实测出现过"当日晚发、次日 15:49 才到"的方案，
//    它是跨天到达，红字提示的必要性与过夜完全相同。
const OVERNIGHT_RE = /过夜|住宿|住一晚|一晚|夜行|留宿|过宿|次日|翌日|\(\+1\s*天\)/;
// 需要红字强调的注脚（给不出更多方案的原因等）
const WARNFOOT_RE = /不推荐|余票不足|余票不够|票不够|无票|放弃/;
const isOvernight = t => OVERNIGHT_RE.test(String(t || ''));
const isWarnFootnote = t => WARNFOOT_RE.test(String(t || '')) || isOvernight(t);

// 数据里若混进 markdown 粗体标记（**），页面会把它原样印出来——因为渲染走的是 esc()，
// 不做 markdown 解析。实测：技能示例把 price 写成 "**二等座 ¥250.0 / 人**"，照抄就会在
// 页面上印出四个星号，逼执行者重出一遍 HTML。这里是所有数据文本的唯一出口，统一剥掉。
const esc = s => String(s == null ? '' : s)
  .replace(/\*\*/g, '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ---------- 文案防重复（数据里误带渲染标签时自动剥离）----------
// 除了精确匹配当前 label，还剥掉常见变体（如「打车备选」）——否则模型把标签写进内容里，
// 渲染时会变成「打车约 打车备选 9 km」这种重复字。
// 以下 stripLead / legNo / card3 / kmText 与 validateData 统一由 lib/validate.js 提供（见文件顶部 require）
// —— 这里不再保留副本，避免与「预研门禁 spots_check.js」两份实现漂移。

// ---------- 文档骨架 ----------
const secs = [];
const blocks = [];
function sec(id, title, sub, inner) {
  secs.push({ id, label: title });
  blocks.push(`<section class="sec" id="${id}"><h2>${esc(title)}</h2>` +
    (sub ? `<p class="sub">${esc(sub)}</p>` : '') + inner + `</section>`);
}

function timeline(steps) {
  return '<ol class="tl">' + (steps || []).map(st => {
    const warn = st.warn === true || isOvernight(`${st.time}${st.place}${st.desc}`);
    return `<li${warn ? ' class="warn"' : ''}>` +
      `<span class="t">${esc(st.time)}</span>` +
      `<span class="p">${esc(st.place)}</span>` +
      `<span class="d">${esc(st.desc)}</span></li>`;
  }).join('') + '</ol>';
}

function costCard(p) {
  const rows = p.costRows || [];
  const body = rows.map((r, i) => {
    const total = i >= rows.length - 2;
    return `<div class="crow${total ? ' total' : ''}"><span>${esc(r[0])}</span><b>${esc(r[1])}</b></div>`;
  }).join('');
  const fns = (p.footnotes || []).map((fn, i) => {
    const warn = isWarnFootnote(fn);
    return `<p class="fn${warn ? ' warn' : (i === 0 ? '' : ' deep')}">${esc(fn)}</p>`;
  }).join('');
  return `<aside class="cost"><h4>${esc(p.costTitle || '费用明细（人均）')}</h4>` +
    body + (fns ? `<div class="fns">${fns}</div>` : '') + `</aside>`;
}

function ovTable(ov, opts = {}) {
  const rows = ov.rows || [];
  const cw = ov.colWidths || [];
  const sum = cw.reduce((a, b) => a + b, 0) || 1;
  const cols = cw.map(w => `<col style="width:${(w / sum * 100).toFixed(3)}%">`).join('');
  const body = rows.map((r, i) => {
    if (i === 0) return `<tr class="th">${r.map(c => `<td>${esc(c)}</td>`).join('')}</tr>`;
    const tds = r.map((cell, j) => {
      const hot = opts.hotLastCol && j === r.length - 1 && cell === '热门';
      const cls = [isOvernight(cell) ? 'warn' : '', hot ? 'hot' : '',
        opts.boldCols && opts.boldCols.includes(j) ? 'b' : ''].filter(Boolean).join(' ');
      return `<td${cls ? ` class="${cls}"` : ''}>${esc(cell)}</td>`;
    }).join('');
    return `<tr>${tds}</tr>`;
  }).join('');
  return `<div class="tblwrap"><table class="ov"><colgroup>${cols}</colgroup><tbody>${body}</tbody></table></div>`;
}

// 注脚三种写法通用：footnotes / note / noteBox
// 「余票不足 / 无票 / 过夜」这类原因注脚一律标红——与方案块的 footnotes 同口径（总览表注脚也适用）。
const notes = (raw, cls = '') => {
  const arr = raw ? (Array.isArray(raw) ? raw : [raw]) : [];
  return arr.map(t => {
    const klass = [cls, isWarnFootnote(t) ? 'warn' : ''].filter(Boolean).join(' ');
    // 没有附加类时不留尾空格：class="note " 会让校验器的空壳正则匹配不到
    return `<p class="note${klass ? ' ' + klass : ''}">${esc(t)}</p>`;
  }).join('');
};

function planCard(p, fallbackTitle, fallbackSub) {
  const title = p.title || fallbackTitle || '';
  const sub = p.subtitle || fallbackSub || '';
  const strip = [p.price, p.badge].filter(Boolean).join('　·　');
  const head = (title || sub)
    ? `<header class="pchead">${title ? `<h3>${esc(title)}</h3>` : ''}${sub ? `<p>${esc(sub)}</p>` : ''}</header>`
    : '';
  return `<article class="plancard">
    ${head}
    <div class="planbody">${timeline(p.steps)}${costCard(p)}</div>
    ${strip ? `<div class="strip">${esc(strip)}</div>` : ''}
  </article>`;
}

function hero(d) {
  const cards = (d.coverCards || []).map(c => {
    const t = card3(c) || [];
    const warn = isOvernight(`${t[0] || ''}${t[2] || ''}`);
    return `<div class="stat"><span class="${warn ? 'warn' : ''}">${esc(t[0])}</span>` +
      `<b>${esc(t[1])}</b><span class="${warn ? 'warn' : ''}">${esc(t[2])}</span></div>`;
  }).join('');
  return `<section class="hero"><h1>${esc(d.coverTitle || d.title || '')}</h1>` +
    `<p class="lede">${esc(d.coverSubtitle || d.subtitle || '')}</p>` +
    `<div class="stats">${cards}</div>` +
    (d.coverNote ? `<p class="banner">${esc(d.coverNote)}</p>` : '') + `</section>`;
}

// ---------- 流程一：城际交通方案 ----------
function buildPlan(d) {
  blocks.push(hero(d));
  if (d.overview) {
    sec('overview', d.overview.title || '决策速览', d.overview.subtitle,
      ovTable(d.overview, { boldCols: [3] }) +
      notes(d.overview.footnotes || d.overview.note || d.overview.noteBox));
  }
  if (d.cheapest && d.cheapest.plans) {
    sec('cheapest', d.cheapest.title || '最省钱方案', d.cheapest.subtitle,
      d.cheapest.plans.map(p => planCard(p)).join(''));
  }
  if (d.fastest) {
    sec('fastest', d.fastest.title || '最快方案', d.fastest.subtitle,
      planCard({ title: '', subtitle: '', steps: d.fastest.steps, price: d.fastest.price,
        badge: d.fastest.badge, costTitle: d.fastest.costTitle,
        costRows: d.fastest.costRows, footnotes: d.fastest.footnotes }));
  }
  const extra = d.extra;
  if (extra && extra.plans) {
    sec('extra', extra.title || '额外方案', extra.subtitle,
      extra.plans.map(p => planCard(p)).join(''));
  }
  return;
}

// 只渲染非空项：字段缺项时不留「② 」这种空序号（esc() 会把 undefined 吞成空串，光靠它守不住）
const numList = arr => (arr || [])
  .filter(x => String(x == null ? '' : x).trim() !== '')
  .map((t, i) => `<p>${'①②③④⑤'[i] || '·'} ${esc(t)}</p>`).join('');
const dotList = arr => (arr || [])
  .filter(x => String(x == null ? '' : x).trim() !== '')
  .map(t => `<p>· ${esc(t)}</p>`).join('');

// ---------- 流程二：目的地景点分析 ----------
function buildSpots(d) {
  blocks.push(hero(d));
  if (d.overview) {
    sec('overview', d.overview.title || '景点总览', d.overview.subtitle,
      ovTable(d.overview, { hotLastCol: true }) +
      notes(d.overview.note || d.overview.footnotes || d.overview.noteBox));
  }
  const cards = (d.spots || []).map(sp => {
    // 好评 / 差评最多 2 条，公开评论极少时可能只有 1 条甚至 0 条 —— 空的那一栏整栏不渲染
    const g = numList(sp.good), b = numList(sp.bad), m = dotList(sp.mine);
    const cols = [];
    if (g) cols.push(`<div class="col"><h4 class="gh">景区好评</h4>${g}</div>`);
    if (b) cols.push(`<div class="col"><h4 class="bh">景区差评</h4>${b}</div>`);
    if (m) cols.push(`<div class="col mine"><h4 class="mh">我的点评</h4>${m}</div>`);
    // 按钮自动带外链箭头 + 一行「点击可在新窗口打开」提示（数据里不用写，避免各景点写法不一）
    const siteLabel = String(sp.urlLabel == null ? '' : sp.urlLabel).replace(/\s*↗\s*$/, '');
    return `<article class="spotcard">
    <header class="schead">
      <div><h3>${esc(sp.name)}</h3><p class="meta">${esc(sp.meta)}</p></div>
      <div class="sitebox">
        <a class="btn" href="${esc(sp.url)}" target="_blank" rel="noopener">${esc(siteLabel)} ↗</a>
        <p class="hint">点击按钮，在新窗口打开该景点页面</p>
      </div>
    </header>
    <div class="grid3 n${cols.length}">
      ${cols.join('')}
    </div>
    ${sp.source ? `<p class="src">${esc(sp.source)}</p>` : ''}
  </article>`;
  }).join('');
  sec('spots', '景点详情', '每个景点：官方网址直达 · 好评差评 · 我的点评（含来源标注）', cards);
  return;
}

// ---------- 流程二：行程方案 ----------
function buildItin(d) {
  blocks.push(hero(d));
  // 口径可切换：公共交通（默认）「公交+打车 / 打车约 / 全程打车备选」；
  // 自驾把 legLabel 设为「行车路线」、taxiLabel 设为「车程」、carLabel 设为「备选路线」。
  const legLabel = d.legLabel === undefined ? '公交+打车' : d.legLabel;
  const taxiLabel = d.taxiLabel === undefined ? '打车约' : d.taxiLabel;
  const carLabel = d.carLabel === undefined ? '全程打车备选' : d.carLabel;

  if (d.overview) {
    sec('overview', d.overview.title || '行程总览 · 串线', d.overview.subtitle,
      ovTable(d.overview, { boldCols: [4] }) +
      notes(d.overview.footnotes || d.overview.note || d.overview.noteBox, 'deep'));
  }

  const legs = (d.legs || []).map((leg, i) => {
    const bus = stripLead(stripLead(leg.bus, legLabel), '公交+打车');
    const taxi = stripLead(stripLead(leg.taxi, taxiLabel), '打车约');
    const car = stripLead(stripLead(leg.car, carLabel), '全程打车备选');
    // 里程 / 说明用非空部分拼接，避免某一段为空时留下悬空的「 · 」
    const meta = [kmText(leg.km), leg.note]
      .filter(x => String(x == null ? '' : x).trim() !== '').map(x => esc(x)).join(' · ');
    return `<article class="legcard">
      <header class="leghead"><h3><span class="no">第 ${esc(legNo(leg.n, i + 1))} 段</span>
        ${esc(leg.from)} <span class="arrow">→</span> ${esc(leg.to)}</h3>
        ${taxi ? `<b class="taxi">${taxiLabel ? esc(taxiLabel) + ' ' : ''}${esc(taxi)}</b>` : ''}</header>
      ${bus ? `<p class="bus">${legLabel ? `<i>${esc(legLabel)}</i>：` : ''}${esc(bus)}</p>` : ''}
      ${meta ? `<p class="legmeta">${meta}</p>` : ''}
      ${car ? `<p class="car">${carLabel ? esc(carLabel) + '：' : ''}${esc(car)}</p>` : ''}
    </article>`;
  }).join('');
  sec('legs', d.legsTitle || '逐段换乘明细',
    d.legsSubtitle || '每段：从哪上车 → 坐哪路 → 到哪站 → 接驳 → 费用',
    `<div class="leggrid">${legs}</div>` +
    (d.legsFootnote ? `<p class="note">${esc(d.legsFootnote)}</p>` : ''));

  if (d.plans) {
    const pc = Array.isArray(d.plans) ? { cards: d.plans } : d.plans;
    // 方案卡的明细行**可以由代码从 legs[] 推出来**（省掉把同一份信息手写两遍）：
    //   `mode:"taxi"`  → 每段取该段的 `taxi`（如"15 分 / ¥18"）
    //   `mode:"bus"`   → 每段取该段的 `bus`
    //   `mode:"mixed"` → `taxiLegs:[1,3]` 指定哪几段打车（1 起算），其余走路/bus
    // 给了 `rows` 就照旧用 `rows`（向后兼容）。实测：三套方案卡逐段明细与 legs[] 是**同一份信息**，
    // 手写两遍既费输出、又埋下"明细改了总价没改"的隐患（route 侧为此专门有 costMismatch 校验）。
    const deriveRows = (c) => {
      if (Array.isArray(c.rows) && c.rows.length) return c.rows;
      const mode = String(c.mode || '').toLowerCase();
      if (!mode) return null;
      const pick = mode === 'mixed' && Array.isArray(c.taxiLegs) ? new Set(c.taxiLegs.map(Number)) : null;
      const rows = (d.legs || []).map((leg, i) => {
        const useTaxi = mode === 'taxi' || (pick && pick.has(i + 1));
        const txt = useTaxi ? (leg.taxi || leg.car) : (leg.bus || leg.taxi);
        return [`${legNo(leg.n, i + 1)} ${leg.from} → ${leg.to}`, String(txt == null || txt === '' ? '—' : txt)];
      });
      if (c.total !== undefined && c.total !== null && String(c.total) !== '') rows.push([c.totalLabel || '合计', String(c.total)]);
      return rows.length ? rows : null;
    };
    const cards = (pc.cards || []).map(c => {
      const rows = deriveRows(c) || [];
      return `<article class="cmpcard${c.hot ? ' hot' : ''}">
      <header><h3>${esc(c.title)}</h3>${c.hot ? `<span class="pill">${esc(c.hotLabel || '推荐')}</span>` : ''}</header>
      <p class="cmpPrice">${esc(c.price)}</p>
      ${c.note ? `<p class="cmpnote">${esc(c.note)}</p>` : ''}
      ${c.tag ? `<div class="ctag">${esc(c.tag)}</div>` : ''}
      <div class="cmprows">${rows.map(r =>
        `<div class="crow"><span>${esc(r[0])}</span><b>${esc(r[1])}</b></div>`).join('')}</div>
      ${c.badge ? `<div class="cbadge">${esc(c.badge)}</div>` : ''}
    </article>`;
    }).join('');
    sec('cmp', pc.title || '移动方案对比', pc.subtitle, `<div class="cmpgrid">${cards}</div>` +
      (pc.note ? `<p class="note">${esc(pc.note)}</p>` : ''));
  }
  return;
}

// ---------- 自驾：路线讲解页（地图截图 + 讲解；图由地图厂商渲染后截图交付） ----------
// 为什么要有这一页：**图（截图）本身看不出一条路线为什么这么走**——客户看到一张地图会问
// "这线为什么绕？为什么不去某市？哪里会堵？" 所以截图之外必须配一份**单文件讲解页**：
// 把截图内嵌进去（data URI，仍然零外链），逐项讲清 ① 图怎么读 ② 途经点是什么 ③ 为什么走这条走廊
// ④ 当天哪里会堵、堵了怎么办 ⑤ 电车在哪充 ⑥ 口径与来源。
// 数据里只写内容：`map.image` 给**截图文件路径**（本脚本自己读文件、转 base64 内嵌）。
const MIME_BY_EXT = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
function inlineImage(p) {
  const abs = path.resolve(p);
  const mime = MIME_BY_EXT[(path.extname(abs).slice(1) || '').toLowerCase()] || 'image/png';
  return `data:${mime};base64,${fs.readFileSync(abs).toString('base64')}`;
}

const FIG_STYLE = 'margin:20px 0 0;background:#fff;border:1px solid var(--line);border-radius:14px;' +
  'box-shadow:var(--shadow);padding:14px';
const IMG_STYLE = 'display:block;width:100%;height:auto;border-radius:10px';

function driveBlock(s, d) {
  if (s.type === 'waypoints') {
    const rows = (s.head || d.waypointsHead || []).length ? [(s.head || d.waypointsHead)].concat(d.waypoints || []) : (d.waypoints || []);
    return ovTable({ rows, colWidths: s.colWidths }, { boldCols: s.boldCols }) + notes(s.note || d.waypointsNote) + notes(d.waypointsNotes);
  }
  if (s.type === 'map') {
    const cap = [s.caption, s.credit].filter(Boolean)
      .map(t => `<span>${esc(t)}</span>`).join('　');
    return `<figure style="${FIG_STYLE}"><img style="${IMG_STYLE}" src="${inlineImage(s.image)}" ` +
      `alt="${esc(s.alt || '自驾路线截图')}">` +
      (cap ? `<figcaption style="margin-top:10px;font-size:13.5px;color:var(--gray)">${cap}</figcaption>` : '') +
      `</figure>` + notes(s.note);
  }
  if (s.type === 'table') {
    const rows = (s.head ? [s.head] : []).concat(s.rows || []);
    return ovTable({ rows, colWidths: s.colWidths }, { boldCols: s.boldCols }) + notes(s.note);
  }
  if (s.type === 'grid3') {
    const cards = s.cards || [];
    return `<div class="grid3${cards.length === 2 ? ' n2' : cards.length === 1 ? ' n1' : ''}">` +
      cards.map(c => `<div class="col${c.mine ? ' mine' : ''}">` +
        `<h4 class="${c.mine ? 'mh' : 'bh'}">${esc(c.head)}</h4>` +
        (c.lines || []).map(l => `<p>${esc(l)}</p>`).join('') + `</div>`).join('') + `</div>` + notes(s.note);
  }
  if (s.type === 'notes') {
    return (s.items || []).map((t, i) => `<p class="note"><b>${i + 1}.</b> ${esc(t)}</p>`).join('') + notes(s.note);
  }
  if (s.type === 'sources') {
    return (s.items || []).map(t => `<p class="src">${esc(t)}</p>`).join('');
  }
  return '';
}

function buildDrive(d) {
  blocks.push(hero(d));
  blocks.push(ovTable(d.overview, { boldCols: d.overview.boldCols }));
  for (const s of (d.sections || [])) sec(s.id, s.title, s.sub, driveBlock(s, d));
}

// ---------- 样式：屏幕优先 + 轻量打印 ----------
const CSS = `
:root{--deep:#065A82;--ink:#16202B;--gray:#5A6675;--line:#DCE3EC;--soft:#F1F6FA;
      --dot:#1C7293;--warn:#C0392B;--green:#2E7D32;--tagbg:#FBF3E8;--tagline:#D9C39A;
      --shadow:0 1px 2px rgba(16,36,56,.05),0 8px 24px rgba(16,36,56,.07)}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;font-family:"Microsoft YaHei","微软雅黑","PingFang SC",system-ui,sans-serif;
     color:var(--ink);font-size:17px;line-height:1.72;background:#F7F9FC;
     -webkit-print-color-adjust:exact;print-color-adjust:exact}
h1,h2,h3,h4{margin:0;font-weight:700;line-height:1.3}
a{color:#0A5FBF}
.warn{color:var(--warn)}
.hot{color:var(--warn);font-weight:700}
.b{font-weight:700}
.wrap{max-width:1180px;margin:0 auto;padding:0 28px}

/* 左侧目录（屏宽够时固定在左边；窄屏折叠成可展开的"目录"） */
.layout{display:flex;align-items:stretch;min-height:100vh}
.sidenav{flex:0 0 250px;width:250px;position:sticky;top:0;height:100vh;overflow-y:auto;
         background:linear-gradient(180deg,#07536F,#053C52);color:#E8F2F7;
         padding:26px 18px 20px;display:flex;flex-direction:column;gap:16px}
.sidenav .brand{font-size:16px;font-weight:700;line-height:1.5;color:#fff}
.sidenav .brand i{display:block;margin-top:7px;font-style:normal;font-size:12.5px;
         font-weight:400;color:#9CC6D8;line-height:1.55}
.sidenav nav{display:flex;flex-direction:column;gap:2px}
.sidenav a{display:block;font-size:14.5px;line-height:1.5;color:#D6E8F0;text-decoration:none;
         padding:9px 12px;border-radius:9px;border-left:3px solid transparent;white-space:normal}
.sidenav a:hover{background:rgba(255,255,255,.13);color:#fff;border-left-color:#7FD1E8}
.sidenav a:focus-visible{outline:2px solid #7FD1E8;outline-offset:2px}
.sidenav .sidefoot{margin-top:auto;padding-top:12px;border-top:1px solid rgba(255,255,255,.18);
         font-size:12px;color:#9CC6D8;line-height:1.6}
.main{flex:1 1 auto;min-width:0;display:flex;flex-direction:column}
/* 窄屏才出现的目录（<details>，无需脚本） */
.tocbar{display:none}
.tocbar summary{cursor:pointer;font-size:15px;font-weight:700;color:var(--deep);
         background:#fff;border:1px solid var(--line);border-radius:10px;padding:11px 14px}
.tocbar nav{display:flex;flex-direction:column;gap:2px;margin-top:8px;background:#fff;
         border:1px solid var(--line);border-radius:10px;padding:10px 14px}
.tocbar a{font-size:14.5px;color:var(--gray);text-decoration:none;padding:6px 0}
.tocbar a:hover{color:var(--deep)}

/* 首屏 */
.hero{padding:56px 0 8px}
.hero h1{font-size:44px;color:var(--deep);letter-spacing:-.5px}
.lede{margin:10px 0 0;font-size:20px;color:var(--gray)}
.stats{display:flex;gap:18px;margin-top:32px;flex-wrap:wrap}
.stat{flex:1 1 220px;background:#fff;border:1px solid var(--line);border-radius:14px;
      padding:18px 20px;box-shadow:var(--shadow);display:flex;flex-direction:column;gap:4px}
.stat span{font-size:14px;color:var(--gray)}
.stat b{font-size:30px;color:var(--ink)}
.banner{margin-top:26px;background:var(--tagbg);border:1px solid var(--tagline);border-radius:12px;
        padding:13px 18px;color:var(--warn);font-weight:700;font-size:16px;text-align:center}

/* 章节 */
.sec{padding:38px 0 4px;scroll-margin-top:26px}
.sec h2{font-size:28px;color:var(--deep)}
.sec>.sub{margin:6px 0 20px;font-size:16px;color:var(--gray)}

/* 表格 */
.tblwrap{background:#fff;border:1px solid var(--line);border-radius:14px;
         box-shadow:var(--shadow);overflow:hidden}
.ov{width:100%;border-collapse:collapse;font-size:16px}
.ov td{padding:15px 18px;border-bottom:1px solid #EDF1F6;vertical-align:top}
.ov tbody tr:last-child td{border-bottom:none}
.ov tr.th td{background:var(--soft);color:var(--deep);font-weight:700;font-size:15px}
.note{margin:12px 0 0;font-size:14.5px;color:var(--gray)}
.note.deep{color:var(--deep)}

/* 方案卡：时间线 + 费用卡 */
.plancard{background:#fff;border:1px solid var(--line);border-radius:14px;
          box-shadow:var(--shadow);padding:24px;margin-bottom:22px}
.pchead{margin-bottom:18px}
.pchead h3{font-size:22px;color:var(--deep)}
.pchead p{margin:5px 0 0;font-size:15px;color:var(--gray)}
.planbody{display:grid;grid-template-columns:minmax(0,1.7fr) minmax(280px,1fr);gap:26px}
.tl{list-style:none;margin:0;padding:0}
.tl li{position:relative;display:grid;grid-template-columns:max-content 150px minmax(0,1fr);
       gap:14px;padding:0 0 22px 26px}
.tl li::before{content:"";position:absolute;left:0;top:9px;width:11px;height:11px;border-radius:50%;
       background:var(--dot);box-shadow:0 0 0 3px #fff}
.tl li:last-child::before{background:var(--deep)}
.tl li::after{content:"";position:absolute;left:5px;top:24px;bottom:2px;
       border-left:2px dashed var(--dot)}
.tl li:last-child::after{display:none}
.tl li.warn::before{background:var(--warn)}
.tl li.warn::after{border-left-color:var(--warn)}
.tl .t{font-size:20px;font-weight:700;color:var(--deep)}
.tl .p{font-weight:700}
.tl li.warn .t,.tl li.warn .p,.tl li.warn .d{color:var(--warn)}
.cost{background:var(--soft);border:1px solid var(--line);border-radius:12px;padding:20px;align-self:start}
.cost h4{font-size:16px;color:var(--deep);margin-bottom:12px}
.crow{display:flex;justify-content:space-between;gap:14px;padding:5px 0;font-size:16px}
.crow.total{font-weight:700;font-size:17px}
.fns{margin-top:12px;border-top:1px dashed var(--line);padding-top:10px}
.fn{margin:0 0 6px;font-size:14px;color:var(--ink)}
.fn.deep{color:var(--deep);font-weight:700}
.fn.warn{color:var(--warn);font-weight:700}
.strip{margin-top:18px;background:var(--tagbg);border:1px solid var(--tagline);border-radius:10px;
       padding:12px;text-align:center;color:var(--warn);font-weight:700;font-size:17px}

/* 景点卡：横向三栏 */
.spotcard{background:#fff;border:1px solid var(--line);border-radius:14px;box-shadow:var(--shadow);
          padding:24px;margin-bottom:22px}
.schead{display:flex;justify-content:space-between;align-items:flex-start;gap:20px;
        border-bottom:1px solid #EDF1F6;padding-bottom:16px;margin-bottom:18px}
.schead h3{font-size:23px;color:var(--deep)}
.meta{margin:5px 0 0;font-size:15px;color:var(--gray)}
/* 景点网址按钮 + 可点击提示（提示语由生成器统一加，数据里不用写）
   —— 溢出安全：urlLabel 是数据驱动文本，长度不可控。A4 703px 下最易爆，
      所以按钮可换行、站点块可收缩（flex:0 1 auto + min-width:0），不再 flex:none。 */
.btn{flex:0 1 auto;min-width:0;max-width:100%;display:inline-block;
     white-space:normal;overflow-wrap:anywhere;
     background:var(--deep);color:#fff !important;text-decoration:none;
     border-radius:10px;padding:11px 20px;font-size:15px;font-weight:700}
.btn:hover{background:#04496A}
.sitebox{flex:0 1 auto;min-width:0;max-width:56%;text-align:right}
.hint{margin:7px 0 0;font-size:13px;color:var(--gray);overflow-wrap:anywhere}
.grid3{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:22px}
.grid3.n2{grid-template-columns:repeat(2,minmax(0,1fr))}
.grid3.n1{grid-template-columns:minmax(0,1fr)}
.grid3 .col{border-left:3px solid var(--line);padding-left:16px}
.grid3 .col.mine{border-left-color:var(--deep);background:#FAFCFE;border-radius:0 10px 10px 0;
                 padding:12px 16px}
.grid3 h4{font-size:16px;margin-bottom:8px}
.gh{color:var(--green)}
.bh{color:#B3261E}
.mh{color:var(--deep)}
.grid3 p{margin:0 0 8px;font-size:16px}
.src{margin:18px 0 0;font-size:13.5px;color:var(--gray)}

/* 逐段卡：两列网格 */
.leggrid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px}
.legcard{background:#fff;border:1px solid var(--line);border-radius:14px;box-shadow:var(--shadow);
         padding:20px;display:flex;flex-direction:column;gap:9px}
.leghead{display:flex;justify-content:space-between;align-items:baseline;gap:14px}
.leghead h3{font-size:18px}
.leghead .no{color:var(--deep)}
.arrow{color:var(--gray)}
.taxi{color:var(--deep);font-size:17px;white-space:normal;overflow-wrap:anywhere;min-width:0;text-align:right}
.bus{margin:0;font-size:16px}
.bus i{font-style:normal;color:var(--deep);font-weight:700}
.legmeta{margin:0;font-size:15px;color:var(--gray)}
.car{margin:0;font-size:14px;color:var(--gray);border-top:1px dashed var(--line);padding-top:9px}

/* 方案对比：三栏 */
.cmpgrid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:20px}
.cmpcard{background:#fff;border:1px solid var(--line);border-radius:14px;box-shadow:var(--shadow);
         padding:22px;display:flex;flex-direction:column;gap:10px}
.cmpcard.hot{border-color:var(--deep);border-width:2px}
.cmpcard header{display:flex;align-items:center;justify-content:space-between;gap:10px}
.cmpcard h3{font-size:19px}
.pill{background:var(--deep);color:#fff;font-size:12.5px;font-weight:700;border-radius:8px;padding:3px 10px}
.cmpPrice{font-size:28px;font-weight:700;margin:0}
.cmpnote{margin:0;font-size:14.5px;color:var(--gray)}
.ctag{background:var(--soft);border:1px solid var(--line);border-radius:8px;padding:7px;
      text-align:center;font-size:14.5px;font-weight:700;color:var(--deep)}
.cmprows{margin-top:6px}
.cbadge{margin-top:auto;background:var(--soft);border:1px solid var(--line);border-radius:10px;
        padding:11px;text-align:center;font-size:14.5px;font-weight:700;color:var(--deep)}

footer{margin-top:56px;border-top:1px solid var(--line);background:#fff}
footer .wrap{padding:26px 28px;font-size:14px;color:var(--gray)}

/* 窄窗口自适应：仅在「屏幕」媒体下生效。
   注意必须限定 screen —— 打印时媒体查询会按页面宽度求值（A4 正文宽约 703px），
   不加限定就会被这个断点误命中，打印版式变成"意外"决定的。 */
@media screen and (max-width:900px){
  .hero h1{font-size:30px}
  .lede{font-size:17px}
  .sec h2{font-size:23px}
  .stat b{font-size:24px}
  .planbody{grid-template-columns:minmax(0,1fr);gap:20px}
  .grid3,.grid3.n1,.grid3.n2{grid-template-columns:minmax(0,1fr);gap:16px}
  .grid3 .col{border-left:3px solid var(--line);padding:10px 14px;background:#FAFCFE;
              border-radius:0 10px 10px 0}
  .leggrid{grid-template-columns:minmax(0,1fr)}
  .cmpgrid{grid-template-columns:minmax(0,1fr)}
  .schead{flex-direction:column}
  .btn{align-self:flex-start}
  .sitebox{align-self:flex-start;text-align:left}
  .tl li{grid-template-columns:max-content minmax(0,1fr);grid-template-rows:auto auto}
  .tl li .d{grid-column:2}
  .sidenav{display:none}
  .tocbar{display:block;margin:14px 0 0}
  .wrap{padding:0 20px}
  .ov{font-size:14px}
  .ov td{padding:10px 10px}
  .ov tr.th td{font-size:13px}
  .tl .t{font-size:17px}
  .cmpPrice{font-size:24px}
}

/* 打印（客户自行用浏览器打印）：A4 纵向，隐藏导航，卡片不跨页断开。
   版式在这里「显式指定」，不依赖屏幕断点。 */
@page{size:A4;margin:12mm}
@media print{
  body{background:#fff;font-size:11pt;line-height:1.6}
  .sidenav,.tocbar{display:none}
  .layout,.main{display:block}
  .wrap{max-width:none;padding:0}
  .hero{padding:0 0 6px}
  .hero h1{font-size:24pt}
  .lede{font-size:12pt}
  .stats{gap:10px;margin-top:14px}
  .stat{padding:12px 14px;box-shadow:none;flex:1 1 30%}
  .stat b{font-size:18pt}
  .banner{margin-top:14px;font-size:11pt;padding:9px 12px}
  .sec{padding:16px 0 0}
  .sec h2{font-size:16pt}
  .sec>.sub{margin:4px 0 12px;font-size:10.5pt}
  .planbody{grid-template-columns:minmax(0,1.6fr) minmax(0,1fr);gap:16px}
  .grid3,.grid3.n1,.grid3.n2{grid-template-columns:minmax(0,1fr);gap:8px}
  .grid3 .col{border-left:3px solid var(--line);padding:6px 12px;background:#FAFCFE;
              border-radius:0 8px 8px 0}
  .leggrid{grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
  .cmpgrid{grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}
  .schead{flex-direction:row}
  .hint{font-size:9.5pt}
  .plancard,.spotcard,.legcard,.cmpcard,.tblwrap,.stat,.banner{break-inside:avoid;box-shadow:none}
  .plancard,.spotcard,.legcard,.cmpcard{padding:14px;margin-bottom:12px}
  .grid3 p,.bus,.ov{font-size:10pt}
  .ov td{padding:8px 10px}
  .tl li{padding-bottom:14px}
  .cmpPrice{font-size:18pt}
  footer{margin-top:20px}
  footer .wrap{padding:12px 0;font-size:9.5pt}
}
`;

function shell(title, subtitle) {
  const nav = secs.map(s => `<a href="#${s.id}">${esc(s.label)}</a>`).join('');
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<title>${esc(title)}</title>
<style>${CSS}</style></head>
<body>
<div class="layout">
<aside class="sidenav">
  <div class="brand">${esc(title)}<i>${esc(subtitle || '')}</i></div>
  <nav>${nav}</nav>
  <div class="sidefoot">点上面任意一节可直接跳到那一节</div>
</aside>
<div class="main">
<details class="tocbar"><summary>目录（${secs.length} 节）</summary><nav>${nav}</nav></details>
<main class="wrap">${blocks.join('\n')}</main>
<footer><div class="wrap">${esc(subtitle || title)} ｜ 本文件为单文件网页，无外部依赖，双击即可用浏览器打开；转发给他人直接转这一个文件即可</div></footer>
</div>
</div>
</body></html>
`;
}

// ---------- 数据校验已移至 lib/validate.js（与 spots_check.js 共用一份）----------

// ---------- 重生成次数上限（防"生成→校验失败→再生成"无限循环）----------
// 为什么需要：HTML → 校验 → 重生成**一次要回放整个上下文**（含上一版完整 HTML，5～20k token）。
// 而没有上限时，执行者可能一轮轮改数据重试，把整场会话的钱烧掉。
// 为什么要落盘计数：`make_html.js` **每次都是新进程**，自己不知道这是第几次；而**模型记不住**自己生成过几次
// ——"记住次数"正是要消除的那种 AI 思考。
const RUNS_FILE = path.join(__dirname, '.make_html_runs.json');
const MAX_RUNS = 2;   // 同一 out.html 最多生成 2 次（第 3 次调用拒绝）
function loadRuns() { try { return JSON.parse(fs.readFileSync(RUNS_FILE, 'utf8')) || {}; } catch { return {}; } }
function bumpRuns(key) {
  const m = loadRuns();
  m[key] = (m[key] || 0) + 1;
  // 只保留最近 60 条，避免无限增长
  const keys = Object.keys(m);
  if (keys.length > 60) for (const k of keys.slice(0, keys.length - 60)) delete m[k];
  try { fs.writeFileSync(RUNS_FILE, JSON.stringify(m, null, 1), 'utf8'); } catch { /* 计数失败不阻断 */ }
  return m[key];
}
function resetRuns(key) { try { const m = loadRuns(); delete m[key]; fs.writeFileSync(RUNS_FILE, JSON.stringify(m, null, 1), 'utf8'); } catch { } }

// ---------- 入口 ----------
// 用 `require.main === module` 守卫：这样本文件可以被 require（拿 validateData 等）而**不会顺带执行生成流程**。
// 从前的顶层 IIFE 会让任何 require 它的脚本直接跑起来，导致校验规则无法被复用。
function main() {
  // `--check`：生成后**同一条命令**接着跑校验。
  // 为什么要有它（2026-09-26 A/B 实测）：一次真实出稿是「make_html ×5 + check_html ×5」
  // = 10 次往返；每一步都要把整个上下文重放一遍（每步约 ¥0.015）。
  // 合成一条命令后是 3 次。同时消灭"忘了跑 check_html 就交付"这一类错误。
  const RAW = process.argv.slice(2);
  // 交付形态只有 HTML：`--pdf` 已移除，见到就直接拒绝（不静默放过，免得执行者以为转出了文件）。
  if (RAW.includes('--pdf')) {
    console.error('PDF 生成已移除 —— 本技能只交付单文件 HTML。请去掉 --pdf，改用：');
    console.error('  node scripts/make_html.js <plan|spots|itin> <data.json> <out.html> --check');
    process.exit(1);
  }
  const DO_CHECK = RAW.includes('--check');
  const argv = RAW.filter(a => a !== '--check');
  const [mode, dataFile, outArg] = argv;
  if (mode === '--reset-runs') {
    // 新任务开始时清掉计数（同一 out.html 的下一次任务不该受上次影响）
    // ⚠ 路径要取 `dataFile`（即 argv 第 3 个），不是 `outArg`（第 4 个）——
    //    因为命令是 `make_html.js --reset-runs <out.html>`，三点参数只到第 3 个（实测踩过）。
    const target = dataFile || outArg;
    if (!target) { console.error('用法: node scripts/make_html.js --reset-runs <out.html>'); process.exit(1); }
    resetRuns(path.resolve(target));
    console.log(`已重置重生成计数: ${path.resolve(target)}`);
    process.exit(0);
  }
  if (mode === '--help' || mode === '-h') {
    console.log([
      'make_html.js —— HTML 生成统一入口（禁止手写生成脚本）',
      '',
      '用法:',
      '  node scripts/make_html.js plan  <data.json> <out.html>    # 城际交通方案页',
      '  node scripts/make_html.js spots <data.json> <out.html>    # 景点推荐页',
      '  node scripts/make_html.js itin  <data.json> <out.html>    # 行程方案页',
      '  node scripts/make_html.js drive <data.json> <out.html>    # 自驾路线讲解页（内嵌地图截图）',
      '',
      '  ★ 推荐一条命令到底（省往返，也免得忘记校验）：',
      '  node scripts/make_html.js plan <data.json> <out.html> --check',
      '    --check  生成后立刻跑 check_html.js（景点页自动带 --spots），FAIL 则以退出码 1 结束',
      '    --reset-runs <out.html>  复位该产物的生成计数（同一路径最多生成 2 次，第 3 次会被拒；要重出就先复位，只写这一条命令、不用数据文件）',
      '  加了 --check 后**不要再单独跑** check_html.js。',
      '  交付形态只有 HTML（不产出 PDF）；客户要纸面请自行用浏览器打印。',
      '',
      '为什么用它: 生成器已固化全部布局 / 字号 / 样式规范。执行时**只需写一个小数据 JSON**，',
      '            不必手写几百行 JS，也不必反复试错调布局。**不要另写生成脚本。**',
      '',
      '它会先校验数据: **缺必需字段就打印可读错误并拒绝生成**，不产出半成品。',
      '  · 封面四件套 coverTitle / coverSubtitle / coverCards / coverNote（cards 每张 3 项：数组 ["标签","值","说明"] 或对象 {label,value,desc} 都接受）',
      '      填好的例子：coverCards: [["推荐景点","5 个","含 3 个热门、2 个不热门"], ["开放时间核对","2026 年 9 月","已按最近公告核对"]]',
      '      —— 三项都要有内容；只写两项会被拒（"有空白项"），这是最常见的退件原因',
      '  · 各方案的 steps / costRows',
      '  · 行程页 legs[]：from / to / km 必需（km 写数字 15.3 或 "15.3 km" 都行）',
      '  · overview.colWidths 必须是**正数数组**（数字权重，个数 = 列数）——写成百分比字符串会静默产出 NaN%',
      '  · 景点页的 url 走**形状闸门**（政务页 / 频道首页 / 携程系 / 短链 / 纯 IP 一律拒绝）',
      '  · 块级字段（plans / extra / fastest）没给就不出那一块',
      '  · 自驾页（drive）：map.image = **地图截图文件路径**（本脚本读文件转 base64 内嵌，交付物仍是单文件）；',
      '      waypoints = 途经点表（第一行是表头）；sections[] = 通用章节（type: map/table/grid3/notes/sources）；',
      '      封面四件套与 overview.rows 与其它页同一口径（同样必需）。',
      '',
      '产出: 「屏幕优先的单文件网页」，零外链零依赖，双击即用浏览器打开。',
      '      不要往里加外链资源——那会让交付物不再是单文件。',
      '      生成后**仍须**过 check_html.js（必须 PASS）。',
      '',
      '**完整字段规范见 SKILL.md「流程一」；本脚本的校验错误会告诉你缺什么。**',
      '退出码: 0 = 生成成功；1 = 用法错误 / 数据校验不通过。',
      '',
      '注意: 不要读本脚本源码——用 --help 就够了。',
    ].join('\n'));
    process.exit(0);
  }
  if (!mode || !dataFile || !outArg) {
    console.error('用法:\n  node scripts/make_html.js plan  <data.json> <out.html>\n' +
      '  node scripts/make_html.js spots <data.json> <out.html>\n' +
      '  node scripts/make_html.js itin  <data.json> <out.html>\n' +
      '  node scripts/make_html.js drive <data.json> <out.html>');
    process.exit(1);
  }
  // 容忍 UTF-8 BOM（PowerShell 写出的 JSON 常带 BOM，否则 JSON.parse 会报错）
  // 数据读入失败给出可读报错（不要甩 node 内部堆栈）
  if (!fs.existsSync(dataFile)) { console.error(`数据文件不存在: ${dataFile}\n（先写出 data.json，再跑本命令；字段规范见 SKILL.md 对应章节）`); process.exit(1); }
  let d;
  try { d = JSON.parse(fs.readFileSync(dataFile, 'utf8').replace(/^\uFEFF/, '')); }
  catch (e) { console.error(`数据文件 JSON 解析失败: ${dataFile}\n  ${String(e.message || e).slice(0, 200)}\n（常见原因：多/少逗号、引号未转义、文件被截断）`); process.exit(1); }

  if (!['plan', 'spots', 'itin', 'drive'].includes(mode)) { console.error('未知模式: ' + mode + '（只能是 plan / spots / itin / drive；--help 看用法）'); process.exit(1); }
  let errs;
  try { errs = validateData(d, mode); } catch (e) { console.error('数据校验器异常（数据形状超出预期）: ' + String((e && e.message) || e)); process.exit(1); }
  if (errs.length) {
    console.error(`数据校验未通过（${errs.length} 项）——未生成任何文件：`);
    errs.forEach(e => console.error('  · ' + e));
    console.error('请修正数据后重新生成；字段规范见 SKILL.md 对应流程章节。');
    process.exit(1);
  }

  // ⚠ 这里**不要**再调一次 buildPlan/buildSpots：`secs` / `blocks` 是模块级数组、不在 build* 里清空，
  //    调两次会把 hero 与全部章节**各渲染两遍**（页面正文变成两倍，导航重复），
  //    而 `check_html.js` 的既有检查**抓不到**。渲染**只在下面重生成上限判定之后做一次**。
  // ── 重生成上限：同一 out.html 最多生成 MAX_RUNS 次 ──
  // 放在数据校验**之后**：数据本身不合法（A2/A4 等）是"还没资格生成"，不该消耗重生成配额。
  const runsKey = path.resolve(outArg);
  const runs = (loadRuns()[runsKey] || 0) + 1;
  if (runs > MAX_RUNS) {
    console.error(`已达重生成上限：${outArg} 已生成 ${MAX_RUNS} 次，仍被校验/校验器拒绝。`);
    console.error('');
    console.error('→ **不要再改数据重试**。按下面顺序定位：');
    console.error('   1. 跑 `node scripts/check_html.js <out.html>`（景点页加 `--spots`），看**具体哪一项** FAIL；');
    console.error('   2. FAIL 若是 A2 / A4（价格未标票种、三段数量不足）→ 属**数据问题**，改 data.json 对应字段；');
    console.error('   3. FAIL 若是 B1 / C（外链、溢出）→ 属**生成器/渲染问题**，如实告诉用户"该页面需修生成器"，不要反复重试；');
    console.error('   4. 实在过不去 → **交付当前版本 + 在聊天里如实说明哪一项没达标**，不要无限重试。');
    console.error('');
    console.error(`（确认要重新开始：node scripts/make_html.js --reset-runs ${outArg}）`);
    process.exit(1);
  }

  if (mode === 'plan') buildPlan(d);
  else if (mode === 'spots') buildSpots(d);
  else if (mode === 'itin') buildItin(d);
  else if (mode === 'drive') buildDrive(d);
  else { console.error('未知模式: ' + mode); process.exit(1); }

  ensureDir(outArg);
  fs.writeFileSync(outArg, shell(d.coverTitle || d.title || mode, d.coverSubtitle), 'utf8');
  bumpRuns(runsKey);
  console.log(`WROTE: ${outArg}  (章节 ${secs.length} 个${runs > 1 ? `；第 ${runs}/${MAX_RUNS} 次生成` : ''})`);

  // ── --check：生成后立刻校验（景点页自动带 --spots）──
  if (DO_CHECK) {
    const checkArgs = [path.join(__dirname, 'check_html.js'), outArg];
    if (mode === 'spots') checkArgs.push('--spots');
    const r = spawnSync(process.execPath, checkArgs, { encoding: 'utf8' });
    process.stdout.write(r.stdout || '');
    if (r.stderr) process.stderr.write(r.stderr);
    const ok = r.status === 0;
    console.log(ok
      ? '\n[make_html --check] 校验 PASS —— 这一页可以直接交付（不要再单独跑 check_html.js）。'
      : `\n[make_html --check] 校验 **FAIL** —— 按上面每一条修数据后重跑本命令；` +
        `本次已计入重生成次数（${runs}/${MAX_RUNS}），不要反复试。`);
    if (!ok) {
      // 校验没过 → **把刚生成的 HTML 删掉**：本脚本对数据不合格的承诺是"不产出半成品"，
      // 这条承诺在 --check 路径上也要成立（否则盘上会留下一个未过校验的页面，可能被误交付）。
      resetRuns(runsKey); // 校验没过不算“生成成功”：退回配额，改完数据还有次数
      try { fs.unlinkSync(outArg); console.log(`[make_html --check] 已删除未通过校验的 ${outArg}（不留半成品）。`); } catch { /* 删不掉就算了 */ }
      process.exit(1);
    }
  }
}

if (require.main === module) main();

// 导出给其它脚本复用（validateData 与 lib/validate.js 是同一份实现）
module.exports = { validateData, shell };
