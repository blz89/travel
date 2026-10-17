#!/usr/bin/env node
/**
 * spot_link.js —— 景点页面链接三轨判定（intro / official / photo）
 *
 * 解决什么：模型自己"觉得"哪个网址是官网，实测经常选到首页、导航页、价目表、
 * 甚至反爬验证页（HTTP 200 但正文是"百度安全验证"）。本脚本把判定交给代码：
 * 抓候选 URL 前 160KB（不进上下文），按「要点密度 / 图文比 / 票务比」打分，
 * 输出三轨推荐，模型照抄进 spots[] 的 links[]。
 *
 * 三轨定义：
 *   intro    图文/要点式景区介绍页（要回答"这是什么、有什么看点"）
 *   official 须知/公告页（开放时间、闭馆日、是否需预约、门票三态的依据）
 *   photo    图集页（可选，只作配图来源，不承担介绍）
 *
 * 用法：
 *   node scripts/spot_link.js resolve --name 西湖 --url <u1> --url <u2> [--json] [--cache]
 *   node scripts/spot_link.js resolve --name 黄山 --urls candidates.json
 *   node scripts/spot_link.js --help
 *
 * 退出码：0 = 三轨里至少有 intro 或 official；1 = 全部候选不合格（模型应写"以景区公示为准"）；
 *         2 = 用法错误。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const MAX_BYTES = 163840;

const RE = {
  intro: /景区介绍|景区概况|概况|简介|风光|景观|以.{0,6}著称|被誉为|历史悠久|文化底蕴|特色|看点|精华/g,
  cult: /始建|相传|历史|文化|遗产|名胜|文人|诗|典故|格局|建筑|园林|山水|意境/g,
  tick: /门票|票价|元\/人|通票|联票|收费|票价标准|购票|优惠/g,
  hours: /开放时间|营业时间|闭馆|开放信息|开馆|闭园/g,
  transit: /交通|公交|地铁|地址|停车场|乘车|步行/g,
  // 要点信号：头衔 + 硬数字（介绍页的"骨头"）
  fact: /5A|AAAAA|4A|世界遗产|世界地质公园|世界生物圈|国家级|国家重点|全国重点|文物保护单位|自然保护区|风景名胜区|平方|公顷|亩|公里|千米|海拔|始建于|公元|唐代|宋代|元代|明代|清代|\d{3,4}年/g,
  anti: /百度安全验证|安全验证|访问受限|Environment Checking|请输入验证码|人机验证/i,
  nav: /(logo|icon|arrow|btn|qrcode|avatar|spacer|blank|loading|share|weibo|weixin|toTop|sprite|pixel|bg)/i,
};
const SECTIONS = ['地理位置', '历史沿革', '景区特色', '主要景点', '自然资源', '气候', '面积', '概况',
  '文化价值', '交通', '开放时间', '荣誉', '奇观', '五绝', '看点'];

function count(text, re) {
  const m = text.match(re);
  return m ? m.length : 0;
}

function analyze(html) {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ');
  const titleM = html.match(/<title[^>]*>([\s\S]{0,120}?)<\/title>/i);
  const title = titleM ? titleM[1].replace(/\s+/g, ' ').trim() : '';

  const han = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
  const longSents = html.replace(/<[^>]+>/g, '\n').split(/[。！？!?]/)
    .filter(s => s.length >= 25 && /[\u4e00-\u9fa5]/.test(s)).length;
  const intro = count(text, RE.intro), cult = count(text, RE.cult), tick = count(text, RE.tick);
  const hours = count(text, RE.hours), transit = count(text, RE.transit), fact = count(text, RE.fact);
  const li = (html.match(/<li\b/gi) || []).length;
  const heads = (html.match(/<h[23]\b/gi) || []).length;
  const sections = SECTIONS.filter(k => text.includes(k)).length;
  const digits = (text.match(/\d+\.?\d*/g) || []).length;

  const imgTags = [...html.matchAll(/<img\b[^>]*>/gi)].map(m => m[0]);
  const imgs = imgTags.filter(t => {
    const src = (t.match(/(?:data-src|data-original|src)\s*=\s*["']([^"']+)/i) || [])[1] || '';
    if (!src || src.startsWith('data:') || RE.nav.test(src)) return false;
    return /\.(jpe?g|png|webp|gif|bmp)/i.test(src.split('?')[0]);
  });
  const altFilled = imgs.filter(t => /alt\s*=\s*["'][^"']{2,}/i.test(t)).length;

  const info = intro + cult * 0.8 + hours + transit * 0.6;
  const price = tick + (text.match(/元\s*\/?\s*人/g) || []).length * 2;
  const ratio = +(info / Math.max(1, price)).toFixed(2);
  // 要点判定：结构式（列表/小标题）或段落式（事实 + 长句 + 数字都密）——文旅局"概况"页多为段落式
  const pointsOk = (fact >= 5 && (li >= 4 || sections >= 3 || heads >= 2))
    || (fact >= 8 && longSents >= 8 && digits >= 12);
  const picsOk = imgs.length >= 3;
  const anti = RE.anti.test(title) || RE.anti.test(html.slice(0, 4000));

  // 三轨得分
  const introScore = +(fact * 1.0 + sections * 2 + (picsOk ? 3 : 0) + (li >= 8 ? 2 : 0) + Math.min(longSents, 10) * 0.3).toFixed(1);
  const officialScore = +(hours * 2 + tick * 0.6 + transit * 0.4 + (/须知|公告|预约/.test(text) ? 2 : 0) + (ratio < 2 ? 1.5 : 0)).toFixed(1);
  const photoScore = +(imgs.length + altFilled * 0.5).toFixed(1);

  return {
    title, han, longSents, intro, cult, tick, hours, transit, fact, li, heads, sections, digits,
    imgs: imgs.length, altFilled, ratio, pointsOk, picsOk, anti,
    scores: { intro: introScore, official: officialScore, photo: photoScore },
  };
}

async function fetchHead(url) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 15000);
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Range: `bytes=0-${MAX_BYTES - 1}`, 'Accept-Language': 'zh-CN,zh' },
      redirect: 'follow', signal: ac.signal,
    });
    let text = '';
    if (res.body) {
      const rd = res.body.getReader();
      const dec = new TextDecoder('utf-8');
      let n = 0;
      while (n < MAX_BYTES) {
        const { done, value } = await rd.read();
        if (done) break;
        n += value.length;
        text += dec.decode(value, { stream: true });
      }
      try { await rd.cancel(); } catch (_) { /* 已读完 */ }
    }
    return { ok: true, status: res.status, ms: Date.now() - t0, bytes: text.length, text };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? '超时 15s' : String(e.message || e), ms: Date.now() - t0 };
  } finally {
    clearTimeout(timer);
  }
}

// 判定单条候选属于哪一轨
function classify(m, url) {
  if (m.anti) return { kind: 'reject', why: '反爬验证页/空页' };
  if (m.han < 250) return { kind: 'reject', why: '正文过短（' + m.han + ' 汉字）' };
  if (m.pointsOk && m.ratio >= 1) return { kind: 'intro', why: `要点${m.fact}/标题${m.sections}/图${m.imgs}` };
  if (m.hours >= 2 || m.tick >= 2 || /须知|公告|预约|开放时间/.test(m.title)) {
    return { kind: 'official', why: `开放/票务信号（开放${m.hours} 票务${m.tick}）` };
  }
  if (m.imgs >= 8 && !m.pointsOk) return { kind: 'photo', why: `纯图集（图${m.imgs}、要点${m.fact}）` };
  if (m.ratio >= 1 && m.pointsOk) return { kind: 'intro', why: '要点够但正文偏短' };
  return { kind: 'weak', why: `信息稀薄（要点${m.fact} 长句${m.longSents}）` };
}

// 域名五档与来源标注都在 lib/host.js（唯一实现，spots_emit 也用它）
const { hostTier, tierLabel } = require('./lib/host');

function usage() {
  console.log(`spot_link.js —— 景点链接三轨判定（intro / official / photo）

用法：
  node scripts/spot_link.js resolve --name <景区名> --url <u1> [--url <u2> ...] [--json] [--cache]
  node scripts/spot_link.js resolve --name <景区名> --urls <candidates.json>   # ["u1","u2"] 或 [{"url":...}]
  node scripts/spot_link.js resolve --name <景区名> --search-hint              # 只打印该查什么，不抓网
  node scripts/spot_link.js refresh [--max-age-days 90] [--all] [--dry-run]   # 批量重跑（过期/全部）

输出（末行，模型照抄进 spots[].links）：
  SPOT_LINK name="西湖" intro="<url>" official="<url>" photo="<url>" checkedAt=2026-10-17

判定门槛（都在脚本里，不用模型判断）：
  intro    = 要点分（头衔/数字/小标题/li + 图≥3）达标 且 票务词不压过介绍词（ratio ≥ 1）
  official = 开放时间/闭馆/预约/票务信号主导（回答"能不能进、要不要买票"）
  photo    = 图 ≥ 8 但要点不足（只能当配图源，不承担介绍）
  反爬验证页（HTTP 200 但正文是"安全验证"）、正文 < 250 汉字：一律剔除

退出码：0 = 至少拿到 intro 或 official；1 = 全部不合格；2 = 用法错误。
候选来源建议：web_search "<景区名> 景区介绍 概况" + "<景区名> 官方 开放时间 公告"，
优先 当地文旅局/管委会/景区官网介绍页（要点式），其次央媒专题；图集/攻略只做 photo 轨。`);
}

function parseArgs(argv) {
  const out = { cmd: argv[0] || '', name: '', urls: [], json: false, cache: false, help: false, maxAgeDays: 90, all: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--name') out.name = argv[++i] || '';
    else if (a === '--url') out.urls.push(argv[++i] || '');
    else if (a === '--urls') out.urlsFile = argv[++i] || '';
    else if (a === '--json') out.json = true;
    else if (a === '--cache') out.cache = true;
    else if (a === '--search-hint') out.searchHint = true;
    else if (a === '--max-age-days') out.maxAgeDays = Number(argv[++i]);
    else if (a === '--all') out.all = true;
    else if (a === '--dry-run') out.dryRun = true;
  }
  return out;
}

// ── refresh：批量重跑过期条目（子进程复用 resolve --cache，避免复制一遍判定逻辑） ──
function refreshMain(args) {
  const { execFileSync } = require('child_process');
  const file = path.join(__dirname, '..', 'data', 'spots-links.json');
  if (!fs.existsSync(file)) { console.error('没有 ' + file + '：先对每个景区跑一次 resolve --cache'); process.exit(2); }
  const db = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  const maxAge = Number.isFinite(args.maxAgeDays) ? args.maxAgeDays : 90;
  const now = Date.now();
  const todo = Object.entries(db).filter(([, v]) => {
    if (args.all) return true;
    const at = v && v.checkedAt ? Date.parse(v.checkedAt) : NaN;
    return !Number.isFinite(at) || (now - at) / 86400000 > maxAge;
  });
  if (!todo.length) { console.log('无需刷新：' + Object.keys(db).length + ' 条都在 ' + maxAge + ' 天内'); process.exitCode = 0; return; }
  console.log('待刷新 ' + todo.length + ' / ' + Object.keys(db).length + ' 条' + (args.dryRun ? '（--dry-run 只看不写）' : ''));
  let ok = 0, bad = 0, skipped = 0;
  for (const [name, v] of todo) {
    const url = (v && v.intro) || '';
    if (!url) { console.log('  - ' + name + '：F 级（记录里没有 intro URL），跳过；要重评请手动 resolve'); skipped++; continue; }
    if (args.dryRun) { console.log('  · ' + name + '  ' + url); continue; }
    try {
      const out = execFileSync(process.execPath, [__filename, 'resolve', '--name', name, '--url', url, '--cache'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 });
      const m = /SPOT_LINK[^\n]*grade=([ABF])/.exec(out);
      if (m) { ok++; console.log('  ✓ ' + name + '  grade=' + m[1]); } else { bad++; console.log('  ✗ ' + name + '：这次没判出等级，保留旧记录'); }
    } catch (e) {
      const out = ((e && e.stdout) || '').toString();
      const m = /SPOT_LINK[^\n]*grade=([ABF])/.exec(out);
      if (m) { ok++; console.log('  ✓ ' + name + '  grade=' + m[1]); } else { bad++; console.log('  ✗ ' + name + '：' + String((e && e.message) || e).slice(0, 100)); }
    }
  }
  console.log('REFRESH done ok=' + ok + ' bad=' + bad + (skipped ? ' skipped=' + skipped : '') + (args.dryRun ? ' dry-run' : ''));
  process.exitCode = bad ? 1 : 0;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.cmd) { usage(); process.exit(args.help ? 0 : 2); }
  if (args.cmd === 'refresh') { refreshMain(args); return; }
  if (args.cmd !== 'resolve') { console.error('未知子命令：' + args.cmd); usage(); process.exit(2); }
  if (args.searchHint) {
    console.log(`建议检索（每个景区 2 条 query 封顶，拿到候选就停）：
  1) ${args.name || '<景区名>'} 景区介绍 概况
  2) ${args.name || '<景区名>'} 官方 开放时间 公告
优先看域名：当地文旅局/管委会（.gov.cn）、景区自建站、央媒专题。`);
    process.exit(0);
  }
  if (args.urlsFile) {
    const raw = JSON.parse(fs.readFileSync(args.urlsFile, 'utf8'));
    for (const it of raw) args.urls.push(typeof it === 'string' ? it : it.url);
  }
  args.urls = [...new Set(args.urls.filter(Boolean))];
  if (!args.urls.length) { console.error('缺少 --url（至少 1 个候选）'); process.exit(2); }

  const results = [];
  for (const url of args.urls) {
    const r = await fetchHead(url);
    if (!r.ok) { results.push({ url, kind: 'reject', why: r.error, m: null, ms: r.ms }); continue; }
    const m = analyze(r.text);
    const c = classify(m, url);
    results.push({ url, kind: c.kind, why: c.why, m, status: r.status, ms: r.ms, tier: hostTier(url) });
  }

  // 三轨推荐：主判据得分 + 域名层级做同分裁决（政府/景区自建站优先）
  const tierRank = { gov: 4, assoc: 3, media: 2, site: 1, aggregator: 0 };
  const rank = list => list.slice().sort((a, b) =>
    (b.m.scores[b.kind === 'photo' ? 'photo' : b.kind] - a.m.scores[a.kind === 'photo' ? 'photo' : a.kind])
    || (tierRank[b.tier] - tierRank[a.tier]))[0];
  const pick = kind => { const l = results.filter(r => r.kind === kind && r.m); return l.length ? rank(l) : null; };

  const best = { intro: pick('intro'), official: pick('official'), photo: pick('photo') };
  // photo 轨兜底：没有纯图集时，取图最多的合格页（图 ≥8，且不与 intro/official 重复）
  if (!best.photo) {
    const used = new Set([best.intro && best.intro.url, best.official && best.official.url].filter(Boolean));
    const pool = results.filter(r => r.m && !r.m.anti && r.m.imgs >= 8 && !used.has(r.url));
    if (pool.length) best.photo = pool.sort((a, b) => b.m.imgs - a.m.imgs)[0];
  }
  // official 轨兜底：没有"票务/须知主导"页时，退而取开放时间信号最强的页（≥1 次，且不重复 intro）
  if (!best.official) {
    const pool = results.filter(r => r.m && !r.m.anti && r.m.hours >= 1 && (!best.intro || r.url !== best.intro.url));
    if (pool.length) best.official = pool.sort((a, b) => b.m.hours - a.m.hours)[0];
  }
  const _now = new Date();
  const today = `${_now.getFullYear()}-${String(_now.getMonth() + 1).padStart(2, '0')}-${String(_now.getDate()).padStart(2, '0')}`;
  const payload = {
    name: args.name || '', checkedAt: today,
    intro: best.intro ? { url: best.intro.url, why: best.intro.why } : null,
    official: best.official ? { url: best.official.url, why: best.official.why } : null,
    photo: best.photo ? { url: best.photo.url, why: best.photo.why } : null,
    candidates: results.map(r => ({ url: r.url, kind: r.kind, why: r.why, http: r.status, ms: r.ms })),
  };

  // ---- 评审等级：这是"网址质量闸门"的判据，spots_check 会回来核对 ----
  // A = 要点足 + 有配图（≈ 文旅局/管委会"概况"页的最佳形态）
  // B = 要点足、图少（仍可交付）
  // F = 没有合格介绍页（模型必须写 urlFallback，不得硬挂别的链接）
  let grade = 'F', reason = '';
  if (best.intro && best.intro.m) {
    const m = best.intro.m;
    if (m.fact >= 10 && m.imgs >= 3) { grade = 'A'; reason = `要点${m.fact} 图${m.imgs} ratio${m.ratio}`; }
    else if (m.fact >= 5) { grade = 'B'; reason = `要点${m.fact} 图${m.imgs}（图少）`; }
    else reason = `要点仅${m.fact}`;
  } else {
    reason = '候选里没有"要点式介绍页"';
  }
  payload.grade = grade;
  payload.reason = reason;
  payload.source = best.intro ? tierLabel(best.intro.url) : '';

  if (args.json) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log(`候选 ${results.length} 条（景区：${args.name || '未命名'}）`);
    results.forEach((r, i) => {
      const m = r.m;
      const detail = m
        ? `要点${m.fact} 小标题${m.sections} li${m.li} 数字${m.digits} 长句${m.longSents} | 汉字${m.han} 介绍${m.intro} 票务${m.tick} 开放${m.hours} ratio${m.ratio} | 图${m.imgs}(alt${m.altFilled})`
        : (r.why || '');
      console.log(`[${i + 1}] ${r.kind === 'reject' ? '✗ 剔除' : r.kind === 'weak' ? '△ 弱' : r.kind === 'intro' ? '★ intro' : r.kind === 'official' ? '◆ official' : '◇ photo'}  ${r.why}  ${r.ms}ms`);
      console.log(`    ${detail}`);
      console.log(`    ${r.url}`);
    });
    console.log('');
    console.log(`SPOT_LINK name="${payload.name}" grade=${grade} source="${payload.source || ''}" intro="${payload.intro ? payload.intro.url : ''}" official="${payload.official ? payload.official.url : ''}" photo="${payload.photo ? payload.photo.url : ''}" checkedAt=${today}  # ${reason}`);
    if (grade === 'F') console.log('提示：没有合格介绍页 —— 该景点写 url 留空 + urlFallback:"以景区公示为准"，不要拿别的链接顶上。');
    if (grade === 'B') console.log('提示：B 级（要点足但图少）可交付；若客户要"美图"再补一次 search 找图集，别把它当介绍页。');
  }

  if (args.cache && args.name) {
    const file = path.join(__dirname, '..', 'data', 'spots-links.json');
    let db = {};
    try { db = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { db = {}; }
    const im = best.intro && best.intro.m ? best.intro.m : {};
    db[args.name] = {
      intro: payload.intro ? payload.intro.url : '',
      grade,
      fact: im.fact || 0,
      imgs: im.imgs || 0,
      ratio: im.ratio || 0,
      reason,
      source: payload.source || '',
      checkedAt: today,
    };
    const prev = db[args.name] || null;
    const next = db[args.name];
    const sameAsPrev = prev && ['intro', 'grade', 'fact', 'imgs', 'ratio', 'reason', 'source'].every((k) => String(prev[k] ?? '') === String(next[k] ?? ''));
    if (sameAsPrev) {
      console.error(`缓存未变（${args.name} 的评审结论与上次一致，不重写文件、不刷新日期）`);
    } else {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(db, null, 2) + '\n', 'utf8');
      console.error(`已写入缓存：${file}（${Object.keys(db).length} 个景区）`);
    }
  }

  // 用 exitCode 而不是 process.exit：抓取是并发句柄，硬退会触发 libuv 断言（Windows 上实测）
  process.exitCode = (payload.intro || payload.official) ? 0 : 1;
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(2); });
