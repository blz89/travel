#!/usr/bin/env node
'use strict';
// spots_urlcheck.js —— 网址可达性 + 反爬判定（只读前 4 KB 正文，不进上下文）
// 目的：景点预研阶段别用 5~8 次 web_fetch 去撞“百度安全验证 / 携程验证 / WAF 页面”。
// 用法：
//   node scripts/spots_urlcheck.js check <url> [<url> ...] [--json] [--timeout 12000]
//   node scripts/spots_urlcheck.js --file urls.json          # ["u1","u2"] 或 [{"url":"…"}]
// 判定：ok / redirect / blocked / dead / thin / error
//   退出码：0 全部 ok（或 redirect 但在同域）；1 有 blocked/dead/thin/error；2 用法错误

const http = require('http');
const https = require('https');
const fs = require('fs');
const { URL } = require('url');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';
const ANTI = [
  [/百度安全验证|安全验证.*百度/i, '百度安全验证页'],
  [/携程旅行验证|验证码拦截/i, '携程验证页'],
  [/Environment Checking/i, 'WAF 环境检测'],
  [/访问过于频繁|访问频繁|请求过于频繁/, '限流页'],
  [/Just a moment|cf-browser-verification|cloudflare/i, 'Cloudflare 挑战'],
  [/Robot Check|are you a robot/i, '反爬页'],
  [/404 Not Found|页面不存在|页面走丢了/i, '错误页'],
];

function fetchHead(url, timeout, depth = 0) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch { return resolve({ verdict: 'error', why: 'URL 无法解析', url }); }
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.get(u, {
      headers: { 'user-agent': UA, 'accept': 'text/html,*/*', 'accept-language': 'zh-CN,zh;q=0.9' },
      timeout,
    }, (res) => {
      const status = res.statusCode || 0;
      const loc = res.headers.location;
      if (status >= 300 && status < 400 && loc && depth < 5) {
        const next = new URL(loc, u).toString();
        const sameHost = new URL(next).host === u.host;
        res.resume();
        return fetchHead(next, timeout, depth + 1).then((r) => resolve({ ...r, redirect: { from: url, to: r.url, sameHost } }));
      }
      let raw = '';
      let bytes = 0;
      let settled = false;
      res.setEncoding('utf8');
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve(judge({ url: u.toString(), status, raw, bytes, ctype: res.headers['content-type'] || '' }));
      };
      res.on('data', (c) => {
        raw += c;
        bytes += Buffer.byteLength(c);
        if (bytes > 4096) { try { res.destroy(); } catch (_) {} finish(); }
      });
      res.on('end', finish);
      res.on('close', finish);
      res.on('error', finish);
    });
    req.on('timeout', () => { try { req.destroy(); } catch (_) {} resolve({ verdict: 'error', why: '超时', url }); });
    req.on('error', (e) => resolve({ verdict: 'error', why: String(e.code || e.message).slice(0, 60), url }));
  });
}

function judge({ url, status, raw, bytes, ctype }) {
  const base = { url, status, bytes, ctype: ctype.split(';')[0] };
  if (/application\/(pdf|zip|octet-stream)/.test(ctype)) return { ...base, verdict: 'ok', why: '直链文件（非网页）' };
  if (status === 403 || status === 412 || status === 429) return { ...base, verdict: 'blocked', why: 'HTTP ' + status + '（拒绝访问 / 反爬）' };
  if (status >= 400) return { ...base, verdict: 'dead', why: 'HTTP ' + status };
  for (const [re, why] of ANTI) if (re.test(raw)) return { ...base, verdict: 'blocked', why };
  const han = (raw.match(/[\u4e00-\u9fa5]/g) || []).length;
  if (status >= 200 && status < 300 && han < 60) return { ...base, verdict: 'thin', why: `正文汉字 ${han} 个（疑似 JS 渲染或空壳页）` };
  return { ...base, verdict: 'ok', why: `正文汉字 ${han} 个` };
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h') || !argv.length) {
    console.log(`spots_urlcheck.js —— 网址可达性 / 反爬判定（只读前 4 KB）

用法：
  node scripts/spots_urlcheck.js check <url> [<url> ...] [--json] [--timeout 12000]
  node scripts/spots_urlcheck.js --file urls.json

判定：ok / redirect / blocked / dead / thin / error
退出码：0 = 全部 ok 或同域跳转；1 = 有 blocked / dead / thin / error；2 = 用法错误
末行：URLCHECK ok=<n> bad=<m>`);
    process.exitCode = argv.length ? 0 : 2;
    return;
  }
  const ji = argv.indexOf('--json');
  const json = ji >= 0;
  const ti = argv.indexOf('--timeout');
  const timeout = ti >= 0 ? Math.max(2000, Number(argv[ti + 1]) || 12000) : 12000;
  let urls = [];
  const fi = argv.indexOf('--file');
  if (fi >= 0) {
    const f = argv[fi + 1];
    if (!f || !fs.existsSync(f)) { console.error('找不到文件：' + f); process.exitCode = 2; return; }
    const arr = JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''));
    urls = arr.map((x) => (typeof x === 'string' ? x : x && x.url)).filter(Boolean);
  } else {
    urls = argv.slice(1).filter((a) => /^https?:\/\//i.test(a));
  }
  if (!urls.length) { console.error('没有可检查的 URL（要用 http(s) 开头）'); process.exitCode = 2; return; }

  const results = [];
  for (const u of urls) {
    const r = await fetchHead(u, timeout);
    if (r.verdict === 'ok' && r.redirect) r.verdict = r.redirect.sameHost ? 'ok' : 'redirect';
    results.push(r);
  }
  const bad = results.filter((r) => r.verdict !== 'ok');
  if (json) console.log(JSON.stringify({ results, ok: results.length - bad.length, bad: bad.length }, null, 2));
  else {
    results.forEach((r, i) => {
      const icon = r.verdict === 'ok' ? '✓' : r.verdict === 'redirect' ? '↪' : '✗';
      console.log(`${icon} [${i + 1}] ${r.verdict.toUpperCase()}  ${r.status || ''}  ${r.why}${r.redirect ? `  → ${r.redirect.to}` : ''}`);
      console.log(`     ${r.url}`);
    });
    console.log(`URLCHECK ok=${results.length - bad.length} bad=${bad.length}`);
  }
  process.exitCode = bad.length ? 1 : 0;
}

main().catch((e) => { console.error('URLCHECK 失败：' + (e && e.message || e)); process.exitCode = 2; });
