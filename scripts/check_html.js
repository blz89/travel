#!/usr/bin/env node
/**
 * travel HTML 出品校验（流程一、流程二通用）
 *
 * 用法: node scripts/check_html.js <out.html>
 *
 * 三类检查：
 *   A. 结构（静态）：DOCTYPE / charset / viewport / 导航与章节 / 无未渲染占位符
 *   B. 自包含（静态）：不得引用任何外部资源（CDN、外链样式、外链脚本、外链图片、iframe）
 *      —— 交付物必须是**单文件**，双击就能看、断网也能看
 *   C. 溢出（真实浏览器，三种视口）：
 *      C1 宽屏 1280  —— 屏幕上主用形态
 *      C2 窄窗口 375 —— 窗口被缩小时不得破版
 *      C3 A4 打印版式 703px —— **客户自行用浏览器打印时就按这个宽度排版**，
 *         这里超出的内容打印时会被直接裁掉，所以必须为 0
 *
 * 退出码：0 = PASS；1 = 有 FAIL。C 项在取不到浏览器时降级为 SKIP（不阻断交付，但会明确提示）。
 */

'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

// A4 纵向正文宽（210mm - 左右各 12mm 边距，按 96dpi）
const A4_CONTENT_PX = 703;

const results = [];
const add = (level, name, detail) => results.push({ level, name, detail });
const FAIL = 'FAIL', PASS = 'PASS', SKIP = 'SKIP', WARN = 'WARN';

function probeScript(limitExpr) {
  return `
<script>
(function(){
  var limit = ${limitExpr};
  var vw = document.documentElement.clientWidth;
  var worst = '', worstRight = 0, over = [];
  var all = document.querySelectorAll('*');
  for (var i = 0; i < all.length; i++) {
    var el = all[i], r = el.getBoundingClientRect();
    if (r.width <= 0) continue;
    if (r.right > worstRight) {
      worstRight = r.right;
      worst = el.className ? '.' + String(el.className).split(' ').join('.') : el.tagName;
    }
    if (r.right > limit + 2) {
      over.push((el.className ? '.' + String(el.className).split(' ').join('.') : el.tagName) + '@' + Math.round(r.right));
    }
  }
  document.documentElement.setAttribute('data-dsh-check',
    Math.round(limit) + '|' + vw + '|' + over.length + '|' + worst + '|' +
    Math.round(worstRight) + '|' + over.slice(0, 5).join(' '));
})();
</script>
`;
}

function measure(edge, tmpDir, htmlText, opts) {
  const probeFile = path.join(tmpDir, 'probe-' + opts.id + '.html');
  fs.writeFileSync(probeFile, htmlText.replace('</body>', probeScript(opts.limit) + '</body>'), 'utf8');
  const url = 'file:///' + probeFile.replace(/\\/g, '/').replace(/ /g, '%20');
  let dom;
  try {
    dom = execFileSync(edge, [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--user-data-dir=' + path.join(tmpDir, 'prof'),
      '--window-size=' + opts.windowW + ',' + opts.windowH,
      '--dump-dom', url,
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 60000, maxBuffer: 256 * 1024 * 1024 });
  } catch (e) {
    add(SKIP, 'C ' + opts.label, '浏览器调用失败：' + String(e.message || e).slice(0, 120));
    return;
  }
  const m = dom.match(/data-dsh-check="([^"]*)"/);
  if (!m) {
    add(WARN, 'C ' + opts.label, '未取到量测结果（探针未执行），请人工过一眼');
    return;
  }
  const [limit, vw, overCount, worst, worstRight, overList] = m[1].split('|');
  // 本机 Edge 有最小窗宽（实测约 489px）：请求 375px 时窗口被撑大，量的其实是 489px 版式。
  // 不静默放过——把这件事打出来，免得把"缩不窄"当成"窄屏没问题"。
  if (opts.windowW && Number(vw) > opts.windowW + 20) {
    add(WARN, 'C ' + opts.label,
      `本机浏览器最小窗宽限制：请求 ${opts.windowW}px、实测只有 ${vw}px —— 这一项量的不是 ${opts.windowW}px 版式，极窄版式请另用真机/手机看一眼`);
  }
  if (Number(overCount) === 0) {
    add(PASS, 'C ' + opts.label, `限宽 ${limit}px（视口 ${vw}px）无元素超出；最宽元素 ${worst} 到 ${worstRight}px`);
  } else {
    add(FAIL, 'C ' + opts.label,
      `限宽 ${limit}px 下有 ${overCount} 个元素超出：${overList}${opts.critical ? '——打印时会被直接裁掉，必须修' : '——会被切掉，必须修'}`);
  }
}

// 窄屏真量测：走 CDP 的 Emulation.setDeviceMetricsOverride，把视口真的压到 375
// （--window-size 会被本机最小窗宽撑到 ~489px，量不准）。量不到才退回旧办法 + WARN。
function measureNarrowCdp(tmpDir, htmlText, opts) {
  const probeFile = path.join(tmpDir, 'narrow-' + opts.id + '.html');
  fs.writeFileSync(probeFile, htmlText, 'utf8');
  let out;
  try {
    out = execFileSync(process.execPath, [path.join(__dirname, 'lib', 'narrow.js'), probeFile, '--width', String(opts.windowW), '--height', '900'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 120000, maxBuffer: 8 * 1024 * 1024,
    });
  } catch (e) {
    out = (e.stdout || '').toString();
  }
  const line = String(out).trim().split(/\r?\n/).pop() || '';
  let r = null;
  try { r = JSON.parse(line); } catch { /* 量不到 */ }
  if (!r || !r.ok) {
    add(WARN, 'C ' + opts.label, '窄屏真量测没跑起来（' + String((r && r.error) || 'CDP 未返回') + '）——请人工用手机/极窄窗口看一眼');
    return;
  }
  if (Number(r.overCount) === 0 && Number(r.scrollW) <= opts.windowW + 2) {
    add(PASS, 'C ' + opts.label, `真量测视口 ${r.vw}px（CDP）无元素超出；最宽元素 ${r.worst} 到 ${r.worstRight}px`);
  } else {
    add(FAIL, 'C ' + opts.label,
      `真量测视口 ${r.vw}px 下有 ${r.overCount || '若干'} 个元素超出（页面总宽 ${r.scrollW}px）：${r.overList || ''}——手机端会被切掉，必须修`);
  }
}

function main() {
  const argv = process.argv.slice(2);
  const isSpots = argv.includes('--spots');
  const isQuick = argv.includes('--quick');   // 迭代期：只跑 A/B（静态），跳过浏览器量测
  const noCache = argv.includes('--no-cache'); // 强制重跑
  const file = argv.find(a => !a.startsWith('-'));
  for (const a of argv) { if (['--spots', '--quick', '--no-cache', '--help', '-h'].includes(a)) continue; if (a.startsWith('--') || a.startsWith('-')) { console.error('未知参数: ' + a + '（--help 看用法）'); process.exit(1); } }
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log([
      'check_html.js —— 成品 HTML 出品校验（必须 PASS 才能交付）',
      '',
      '用法:',
      '  node scripts/check_html.js <out.html> [--spots] [--quick] [--no-cache]',
      '    --quick  # 迭代期只跑 A/B（静态检查，<0.2s），交付前必须再跑一次完整版',
      '    --no-cache  # 忽略 10 分钟内的同文件校验结果，强制重跑',
      '    --spots  # 景点页模式：A7 放行"评价来源行"里的平台名（马蜂窝/去哪儿/大众点评/欣欣）',
      '             #            但 12306 / web_search / 脚本名 仍一律不许出现',
      '',
      '它做三类检查:',
      '  A 结构与空占位: DOCTYPE / charset / viewport / 导航与章节是否齐全；',
      '    正文不得出现空壳（空序号行、空单元格、空标题、空数值、空的元信息/注脚），',
      '    以及 undefined / NaN / [object Object]；锚点 id 必须唯一（重复 = 整页被渲染两遍）。',
      '  B 自包含: 不得引用任何外部资源（link / script / iframe / 媒体标签 /',
      '    @import / 非 data: 的 CSS url）。允许的只有 <a href> 出站链接与',
      '    **data: 内联图**（自驾路线讲解页要把地图截图内嵌进去，见 make_html.js drive）。',
      '  C 溢出: 用本机 Edge 无头真实量测——宽屏 1280 / 窄窗口 375 / A4 打印版式 703px。',
      '    1280 / 703 / 375 三档超出都是 FAIL；其中 375 走 CDP 真量测（Emulation.setDeviceMetricsOverride），',
      '    不是窗口缩放——量不到 CDP 时才退回 WARN 并提示人工看。',
      '',
      '退出码: 0 = PASS；1 = 有 FAIL。取不到浏览器时 C 项降级为 SKIP（不阻断交付，但会提示）。',
      '报错处理: 改数据（或生成器）后**重新生成 HTML 再跑一遍**，直到 PASS。',
      '',
      '注意: 不要读本脚本源码——用 --help 就够了。',
    ].join('\n'));
    process.exit(0);
  }
  if (!file) {
    console.error('用法: node scripts/check_html.js <out.html> [--spots]');
    process.exit(1);
  }
  if (!fs.existsSync(file)) {
    console.error('文件不存在: ' + file);
    process.exit(1);
  }
  const html = fs.readFileSync(file, 'utf8');

  // ---- 结果缓存：同文件 + 同大小 + 同 mtime + 同模式，10 分钟内直接复用 ----
  const cachePath = path.join(os.tmpdir(), 'travel-cache', 'check_html_cache.json');
  const st = fs.statSync(file);
  const cacheKey = [path.resolve(file), st.size, Math.round(st.mtimeMs), isSpots ? 'spots' : 'plain', isQuick ? 'quick' : 'full'].join('|');
  if (!noCache) {
    try {
      const db = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      const h = db[cacheKey];
      if (h && Date.now() - h.ts < 10 * 60 * 1000) {
        console.log(`[缓存] 同文件 ${Math.round((Date.now() - h.ts) / 1000)} 秒前校验过、内容未变（--no-cache 强制重跑）`);
        process.stdout.write(h.text);
        process.exit(h.exit);
      }
    } catch (_) { /* 没缓存就正常跑 */ }
  }

  // ---------- A. 结构 ----------
  if (!/^<!DOCTYPE html>/i.test(html.trimStart())) add(FAIL, 'A1 DOCTYPE', '缺少 <!DOCTYPE html>');
  else add(PASS, 'A1 DOCTYPE', '');
  if (!/<meta\s+charset="utf-8"/i.test(html)) add(FAIL, 'A2 charset', '缺少 <meta charset="utf-8">，中文会乱码');
  else add(PASS, 'A2 charset', '');
  if (!/<meta\s+name="viewport"/i.test(html)) add(FAIL, 'A3 viewport', '缺少 viewport');
  else add(PASS, 'A3 viewport', '');

  const secCount = (html.match(/<section class="sec"/g) || []).length;
  if (!/<nav[\s>]/.test(html)) add(FAIL, 'A4 结构', '缺少导航目录（<nav>）');
  else if (!/<main class="wrap"/.test(html)) add(FAIL, 'A4 结构', '缺少 <main class="wrap">');
  else if (secCount < 1) add(FAIL, 'A4 结构', '没有任何章节（section.sec）');
  else add(PASS, 'A4 结构', `导航 + main + ${secCount} 个章节`);

  // A5 空占位 —— 字段缺失时 esc() 会把 undefined 吞成空串，所以只查「undefined」几乎抓不到；
  // 真正该查的是「只剩个序号/标签、后面什么都没有」这类空壳。
  const EMPTY = [
    [/<p>[①②③④⑤·]\s*<\/p>/g, '空的序号行（如「② 」）'],
    [/<td>\s*<\/td>/g, '空表格单元格'],
    [/<h[234]>\s*<\/h[234]>/g, '空标题'],
    [/<b>\s*<\/b>/g, '空数值'],
    [/<span class="[^"]*">\s*<\/span>/g, '空数据格'],
    [/<a class="btn"[^>]*>\s*<\/a>/g, '空链接文字'],
    [/<p class="(?:meta|src|note|sub|psub|hint|legmeta|bus|car)(?:\s[^"]*)?">\s*<\/p>/g, '空的元信息 / 提示 / 注脚'],
    [/<aside class="cost">\s*<h4>[^<]*<\/h4>\s*<\/aside>/g, '空的费用明细卡（只有标题没有费用行）'],
  ];
  const empties = [];
  for (const [re, label] of EMPTY) {
    const n = (html.match(re) || []).length;
    if (n) empties.push(`${label} ×${n}`);
  }
  // ⚠ 扫描 A5 的「未渲染占位符」时要**先把 data: 内联图剥掉**：base64 里随机出现 "NaN"
  //    的概率很高（608 KB 的图实测必中），不剥就会把一张正常的路线讲解页判成"数据缺失"。
  const NO_DATA_URI = html.replace(/data:[^"')\s]+/g, 'data:URI');
  const junk = ['undefined', 'NaN', '[object Object]'].filter(b => NO_DATA_URI.includes(b));
  // 生成器/emit 留下的「待补、「（补写）」这类占位：空串检查抓不到，必须按词表拦。
  const PLACEHOLDER = [/（待填/g, /待填…/g, /（补写）/g, /（待补）/g, /TODO/g, /FIXME/g, /\{\{[^}]+\}\}/g, /路线\s*交通方案/g];
  for (const re of PLACEHOLDER) { const n = (NO_DATA_URI.match(re) || []).length; if (n) junk.push(`占位词「${String(re.source).replace(/[\\（）]/g, '')}」×${n}`); }
  if (empties.length || junk.length) {
    const detail = [empties.join(' / '), junk.length ? '未渲染占位符：' + junk.join(' / ') : '']
      .filter(Boolean).join('；');
    add(FAIL, 'A5 空占位', detail + '（多为数据字段缺失）');
  } else {
    add(PASS, 'A5 空占位', '无空序号 / 空单元格 / 空标题 / 空数值');
  }

  if (html.length < 4000) add(WARN, 'A6 体积', `仅 ${html.length} 字节，疑似渲染不完整`);
  else add(PASS, 'A6 体积', `${(html.length / 1024).toFixed(1)} KB`);

  // A7 页面不得出现技术 / 数据源信息（SKILL.md「输出格式要求」：数据来源只写在聊天回复里，不进网页）。
  // 不是黑名单治理，而是**抽查几个铁定属内部用语的词**；命中即说明内部信息漏进了交付物。
  //
  // ⚠ 两个必须尊重的例外与边界（否则会误伤）：
  //   ① **景点页允许**带"评价来源行"（如"来源：马蜂窝·大众点评 游客高频评价归纳"）——
  //      所以 **马蜂窝/去哪儿/大众点评/欣欣** 这四个平台名在 `--spots` 模式下**放行**；
  //      但"12306"（铁路数据源）**任何页面都不许出现**——它从不是"景点评价来源"。
  //   ② **不扫 URL 本身**：景点页允许放官方网址，域名里出现什么词都不算技术信息。
  const TEXTLIKE = html.replace(/\b(?:href|src|action)\s*=\s*"[^"]*"/gi, '').replace(/\b(?:href|src|action)\s*=\s*'[^']*'/gi, '');
  const TECH = (() => {
    const t = [];
    // 任何页面都不许出现的内部用语
    t.push(...(TEXTLIKE.match(/12306/g) || []));
    t.push(...(TEXTLIKE.match(/OpenFlights/gi) || []));
    t.push(...(TEXTLIKE.match(/web_search/gi) || []));
    for (const m of TEXTLIKE.match(/\b(?:12306|flight|plan|itinerary|make_html|check_html|spots_check|spots_baseline|reply_check|map-shot|congestion-nodes|traffic-history)\.js\b/gi) || []) t.push(m);
    for (const m of TEXTLIKE.match(/\{\{[^}]{0,40}\}\}/g) || []) t.push(m);
    // 景点评价平台名：只在**非景点页**才算违规
    if (!isSpots) {
      for (const m of TEXTLIKE.match(/马蜂窝|去哪儿|大众点评|欣欣旅游/g) || []) t.push(m);
    }
    return [...new Set(t)];
  })();
  if (TECH.length) {
    add(FAIL, 'A7 无技术信息',
      `页面出现内部技术 / 数据源用语：${TECH.join(' / ')} —— ` +
      `**数据来源只写在聊天回复里，不进网页**` +
      `${isSpots ? '（景点页只允许"评价来源行"，不含其他数据源名）' : ''}；` +
      `请从数据里删掉这些词后重新生成`);
  } else {
    add(PASS, 'A7 无技术信息', `未出现数据源名 / 脚本名 / 未渲染标记${isSpots ? '（景点页评价来源行已放行）' : ''}`);
  }

  // A8 锚点唯一（**防「整页被渲染两遍」**）。
  // 生成器把 `secs`/`blocks` 放在模块级数组里且**不在 build* 里清空**，所以一旦入口误调两次
  // `buildPlan`/`buildSpots`，每个章节会被 push 两遍：正文整段重复、导航重复，而
  // A4 只数「有几个 section」、A5 只找空壳、A7 只看技术词——**全都抓不到**（实测漏过一次）。
  // 重复 id 本身也是非法 HTML（锚点跳转只会命中第一个）。本检查零成本、专治这一类。
  const idCounts = new Map();
  for (const m of html.matchAll(/\sid="([^"]+)"/g)) idCounts.set(m[1], (idCounts.get(m[1]) || 0) + 1);
  const dupIds = [...idCounts.entries()].filter(([, n]) => n > 1);
  if (dupIds.length) {
    add(FAIL, 'A8 锚点唯一',
      `同一 id 出现多次：${dupIds.map(([k, n]) => `${k}×${n}`).join(' / ')} —— ` +
      `**页面被渲染了两遍**（生成器入口重复调用了 build*）；请修生成器，不要靠改数据绕过`);
  } else {
    add(PASS, 'A8 锚点唯一', `${idCounts.size} 个锚点均唯一`);
  }

  // ---------- B. 自包含 ----------
  const rules = [
    [/<link\b[^>]*rel=["']?stylesheet/gi, '外链样式表 <link rel=stylesheet>'],
    [/<link\b[^>]*href=/gi, '外链 <link href=…>'],
    [/<script\b[^>]*\bsrc=/gi, '外链脚本 <script src=>'],
    [/<script\b(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/gi, '内联 <script>（可能发起外部请求）'],
    // data: 内联图放行（仍是单文件、断网可看）；只有引外部图片才 FAIL。
    [/<img\b(?![^>]*\bsrc\s*=\s*["']data:)[^>]*>/gi, '<img> 引用了外部图片（只允许 data: 内联图）'],
    [/<iframe\b/gi, '<iframe>'],
    [/<video\b|<audio\b|<source\b/gi, '内嵌媒体标签'],
    [/@import\b/gi, 'CSS @import'],
    [/url\(\s*["']?(?!data:)/gi, 'CSS url(…)（非 data: 内联）'],
  ];
  const external = rules.filter(([re]) => re.test(html)).map(([, label]) => label);
  if (external.length) add(FAIL, 'B1 自包含', '引用了外部资源：' + external.join(' / ') + '（交付物必须单文件）');
  else add(PASS, 'B1 自包含', '零外链、零依赖（允许的只有 <a href> 出站链接）');
  // ---------- C. 溢出（真实浏览器，三种视口） ----------
  if (isQuick) {
    add(PASS, 'C 溢出检查', '--quick 跳过（只验 A/B；交付前请去掉 --quick 再跑一次完整版）');
  } else {
  const edge = EDGE_CANDIDATES.find(p => fs.existsSync(p));
  if (!edge) {
    add(SKIP, 'C 溢出检查', '未找到 Edge/Chrome，跳过浏览器量测（交付不受影响，但请人工过一眼）');
  } else {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-htmlcheck-'));

    // C1 / C2：屏幕媒体，限宽 = 视口宽
    measure(edge, tmpDir, html, {
      id: 'wide', label: 'C1 宽屏（窗口 1280）', windowW: 1280, windowH: 900,
      limit: 'document.documentElement.clientWidth', critical: false,
    });
    measureNarrowCdp(tmpDir, html, {
      id: 'narrow', label: 'C2 窄屏（375px 真量测）', windowW: 375, windowH: 900, critical: true,
    });

    // C3：把打印样式搬到屏幕、禁用窄屏断点、并把文档钉死成 A4 正文宽，量测打印版式
    let printHtml = html
      .replace('@media print{', '@media screen{')
      .replace('@media screen and (max-width:900px)', '@media screen and (max-width:50px)')
      .replace('</head>',
        `<style>html,body{width:${A4_CONTENT_PX}px;max-width:${A4_CONTENT_PX}px;margin:0;padding:0}</style></head>`);
    measure(edge, tmpDir, printHtml, {
      id: 'print', label: `C3 A4 打印版式 ${A4_CONTENT_PX}px（客户自行打印时）`,
      windowW: 900, windowH: 1200, limit: String(A4_CONTENT_PX), critical: true,
    });

    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
  }
  }

  // ---------- 报告 ----------
  const order = { FAIL: 0, WARN: 1, SKIP: 2, PASS: 3 };
  results.sort((a, b) => order[a.level] - order[b.level]);
  const outLines = ['HTML 出品校验：' + path.basename(file), '─'.repeat(74)];
  for (const r of results) outLines.push(`[${r.level}] ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
  outLines.push('─'.repeat(74));
  const fails = results.filter(r => r.level === FAIL).length;
  const warns = results.filter(r => r.level === WARN).length;
  const exit = fails ? 1 : 0;
  outLines.push(fails ? `结论：FAIL（${fails} 项不通过）` : `结论：PASS${warns ? `（${warns} 项提示，建议看一眼）` : ''}`);
  const text = outLines.join('\n') + '\n';
  process.stdout.write(text);
  // 落缓存（同文件 10 分钟内、内容未变时直接复用，避免每次交付白烧 ~34s）
  if (!noCache) {
    try {
      fs.mkdirSync(path.dirname(cachePath), { recursive: true });
      let db = {};
      try { db = JSON.parse(fs.readFileSync(cachePath, 'utf8')); } catch (_) {}
      db[cacheKey] = { ts: Date.now(), exit, text };
      fs.writeFileSync(cachePath, JSON.stringify(db), 'utf8');
    } catch (_) { /* 缓存失败不影响校验 */ }
  }
  process.exit(exit);
}

if (require.main === module) main();

module.exports = { main };
