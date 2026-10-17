#!/usr/bin/env node
/**
 * lib/narrow.js —— 用 CDP 在指定视口宽度真量测「有没有元素超出视口」
 *
 * 为什么需要：本机 Edge 无头模式有最小窗宽（实测约 489px），`--window-size=375`
 * 会被撑大，量的其实是 489px 版式。走 CDP 的 Emulation.setDeviceMetricsOverride
 * 才能真正把视口压到 375 / 414 / 393。
 *
 * CLI（check_html.js 就是这么调它的，保持同步流程）:
 *   node scripts/lib/narrow.js <file.html> [--width 375] [--height 900] [--json]
 * 最后一行输出 JSON: {"ok":true,"vw":375,"overCount":0,"worst":".card","worstRight":370,"overList":"","scrollW":375}
 * 失败时 {"ok":false,"error":"..."}；退出码 0=量到结果，1=没量到。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findEdge() {
  return [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ].find((p) => fs.existsSync(p));
}

const PROBE = `(() => {
  const vw = document.documentElement.clientWidth;
  let worst = '', worstRight = 0;
  const over = [];
  const all = document.querySelectorAll('*');
  for (let i = 0; i < all.length; i++) {
    const el = all[i];
    const r = el.getBoundingClientRect();
    if (r.width <= 0) continue;
    const cls = el.className ? '.' + String(el.className).split(' ').join('.') : el.tagName;
    if (r.right > worstRight) { worstRight = r.right; worst = cls; }
    if (r.right > vw + 2) over.push(cls + '@' + Math.round(r.right));
  }
  const de = document.documentElement;
  const scrollW = Math.max(de.scrollWidth, document.body ? document.body.scrollWidth : 0);
  return { vw, overCount: over.length, worst, worstRight: Math.round(worstRight), overList: over.slice(0, 5).join(' '), scrollW };
})()`;

async function measure(file, width, height) {
  const EDGE = findEdge();
  if (!EDGE) throw new Error('找不到 Microsoft Edge / Chrome（msedge.exe / chrome.exe）');
  if (typeof WebSocket !== 'function') throw new Error('需要 Node ≥ 21（全局 WebSocket）');
  const PORT = 9400 + Math.floor(Math.random() * 500);
  const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'narrow-'));
  const url = 'file:///' + path.resolve(file).replace(/\\/g, '/').replace(/ /g, '%20');
  // stdio 用 ignore：沙箱下管道 stdio 会 EPERM
  const child = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
    '--window-size=800,900', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', 'about:blank'], { stdio: 'ignore' });
  let ws = null;
  try {
    let target = null;
    for (let i = 0; i < 60 && !target; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
        target = list.find((t) => t.type === 'page');
      } catch { /* 未就绪 */ }
      if (!target) await sleep(250);
    }
    if (!target) throw new Error('CDP 未就绪（浏览器没起来？）');
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('CDP WebSocket 连接失败')); });
    const pend = new Map();
    let id = 0;
    const seen = new Set();
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
      else if (m.method) seen.add(m.method);
    };
    const cmd = (method, params = {}) => new Promise((res, rej) => {
      const mid = ++id;
      pend.set(mid, { res, rej });
      ws.send(JSON.stringify({ id: mid, method, params }));
      setTimeout(() => { if (pend.has(mid)) { pend.delete(mid); rej(new Error(method + ' 超时')); } }, 30000);
    });
    await cmd('Page.enable');
    await cmd('Runtime.enable');
    await cmd('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: true });
    await cmd('Page.navigate', { url });
    for (let i = 0; i < 80 && !seen.has('Page.loadEventFired'); i++) await sleep(100);
    await sleep(200); // 让字体/布局稳定
    const r = await cmd('Runtime.evaluate', { expression: PROBE, returnByValue: true });
    const v = r.result && r.result.value;
    if (!v || !Number.isFinite(v.vw)) throw new Error('探针未返回有效结果');
    return { ok: true, ...v };
  } finally {
    try { if (ws) ws.close(); } catch { /* 忽略 */ }
    try { child.kill(); } catch { /* 忽略 */ }
    await sleep(150);
    try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
}

module.exports = { measure, findEdge };

if (require.main === module) {
  (async () => {
    const argv = process.argv.slice(2);
    const file = argv.find((a) => !a.startsWith('-'));
    const get = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
    if (!file || argv.includes('--help') || argv.includes('-h')) {
      console.log('用法: node scripts/lib/narrow.js <file.html> [--width 375] [--height 900] [--json]');
      process.exit(file ? 0 : 2);
    }
    const width = parseInt(get('--width', '375'), 10);
    const height = parseInt(get('--height', '900'), 10);
    try {
      const r = await measure(file, width, height);
      const out = argv.includes('--json') ? JSON.stringify(r) : JSON.stringify(r);
      process.stdout.write(out + '\n');
      process.exitCode = r.overCount === 0 && r.scrollW <= width + 2 ? 0 : 0;
    } catch (e) {
      process.stdout.write(JSON.stringify({ ok: false, error: String(e.message || e).slice(0, 200) }) + '\n');
      process.exitCode = 1;
    }
  })();
}
