#!/usr/bin/env node
'use strict';
/**
 * alias.js —— 英文 / 拼音地名 → 中文地名归一化（客户用 Guangzhou / Zhengzhou / Xi'an 这类写法时先跑这个）
 *
 * 数据：data/city-alias.json（人工维护；含歧义词如 suzhou = 苏州 / 宿州）
 * 用法：
 *   node scripts/alias.js resolve --name "Guangzhou South"
 *   node scripts/alias.js resolve "guangzhounan"
 *   node scripts/alias.js --list
 *   node scripts/alias.js resolve --name "suzhou" --json
 *
 * 结论：
 *   resolved   唯一中文名 → 直接用，不进提问框
 *   ambiguous  多个候选 → 让客户确认一次（算新增字段确认，不是重问）
 *   chinese    输入已是中文 → 不用处理
 *   unknown    未收录 → 让客户写中文，或查一次 web_search
 * 站名方位：输入带 south/north/east/west（或 nan/bei/dong/xi）时拼成「广州南」这类站名。
 */

const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, '..', 'data', 'city-alias.json');

function load() {
  const d = JSON.parse(fs.readFileSync(DATA, 'utf8').replace(/^\uFEFF/, ''));
  return { cities: d.cities || {}, directions: d.directions || {}, suffix: d.suffixes || [], citySuffix: d.citySuffixes || [] };
}

const isChinese = (s) => /[\u4e00-\u9fff]/.test(s);

function normalizeTokens(input) {
  const raw = String(input || '').trim();
  const toks = raw.split(/[\s_\-–—'’.,/()]+/).filter(Boolean);
  return { raw, toks };
}

function stripSuffixes(toks, suffix) {
  const out = toks.slice();
  while (out.length > 1) {
    const last = out[out.length - 1].toLowerCase();
    if (suffix.includes(last)) out.pop();
    else break;
  }
  return out;
}

function resolve(input, data) {
  const raw = String(input || '').trim();
  if (!raw) return { input: raw, verdict: 'unknown', zh: null, type: null, candidates: [], note: '空输入' };
  if (isChinese(raw)) return { input: raw, verdict: 'chinese', zh: raw, type: 'unknown', candidates: [], note: '已是中文，直接使用' };

  const { toks } = normalizeTokens(raw);
  let work = stripSuffixes(toks, data.suffix.map((s) => s.toLowerCase()));
  let dir = null;

  // 末尾方位（south / 南 / nan ...）
  if (work.length > 1) {
    const last = work[work.length - 1].toLowerCase();
    if (data.directions[last]) { dir = data.directions[last]; work = work.slice(0, -1); }
  }

  // 城市名：先去 city 后缀（如 "Guangzhou City"）
  let cityKey = work.join('').toLowerCase().replace(/[\s]/g, '');
  for (const s of data.citySuffix) {
    if (cityKey.length > s.length && cityKey.endsWith(s)) { cityKey = cityKey.slice(0, -s.length); break; }
  }

  let cands = data.cities[cityKey];

  // 「guangzhounan」这类把方位粘在后面的写法：尝试后缀剥离
  if (!cands && !dir) {
    const dirKeys = Object.keys(data.directions).filter((k) => k.length >= 2);
    for (const dk of dirKeys) {
      if (cityKey.length > dk.length + 2 && cityKey.endsWith(dk)) {
        const base = cityKey.slice(0, -dk.length);
        if (data.cities[base]) { cands = data.cities[base]; dir = data.directions[dk]; break; }
      }
    }
  }

  if (!cands) {
    return { input: raw, verdict: 'unknown', zh: null, type: null, candidates: [], note: '未收录：让客户写中文地名，或查一次 web_search 确认' };
  }

  const type = dir ? 'station' : 'city';
  const zhList = cands.map((c) => (dir ? c + dir : c));
  if (zhList.length === 1) {
    return { input: raw, verdict: 'resolved', zh: zhList[0], type, candidates: zhList, note: dir ? `按站名处理（${dir} 站）` : '按城市处理' };
  }
  return { input: raw, verdict: 'ambiguous', zh: null, type, candidates: zhList, note: `有 ${zhList.length} 个候选（中文同音不同字），让客户确认一次` };
}

function usage() {
  console.log([
    'alias.js —— 英文 / 拼音地名 → 中文（客户写 Guangzhou / Zhengzhou / Xi\'an 时先归一化）',
    '',
    '用法：',
    '  node scripts/alias.js resolve --name "Guangzhou South"',
    '  node scripts/alias.js resolve "guangzhounan"',
    '  node scripts/alias.js resolve --name "suzhou" --json',
    '  node scripts/alias.js --list',
    '',
    '结论：',
    '  resolved  唯一中文名 → 直接进流程（不弹框确认）',
    '  ambiguous 多候选（如 suzhou = 苏州 / 宿州）→ 让客户确认一次',
    '  chinese   输入已是中文 → 不处理',
    '  unknown   未收录 → 请客户写中文，或按需查一次 web_search',
    '',
    '方位：south/north/east/west（nan/bei/dong/xi）→ 拼成「广州南」这类站名。',
  ].join('\n'));
}

function main(argv) {
  const args = argv.slice(2);
  if (!args.length || args[0] === '--help' || args[0] === '-h') { usage(); return 0; }
  let data;
  try { data = load(); } catch (e) { console.error(`读不到/解析不了数据文件：${e.message}`); return 2; }

  if (args[0] === '--list') {
    const keys = Object.keys(data.cities).sort();
    console.log(`收录 ${keys.length} 个写法（含歧义词 ${keys.filter((k) => data.cities[k].length > 1).length} 个）：`);
    console.log(keys.map((k) => `${k} → ${data.cities[k].join(' / ')}`).join('\n'));
    return 0;
  }

  let name = null;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === 'resolve') continue;
    if (a === '--name') name = args[++i];
    else if (a === '--json') json = true;
    else if (a.startsWith('--')) { console.error(`未知参数：${a}（看 --help）`); return 2; }
    else if (!name) name = a;
  }
  if (args[0] !== 'resolve' && !name) { console.error('缺少地名（例：resolve --name "Guangzhou"）'); return 2; }
  if (!name) { console.error('--name 后面要跟地名'); return 2; }

  const r = resolve(name, data);
  if (json) { console.log(JSON.stringify(r, null, 2)); return 0; }

  if (r.verdict === 'resolved') console.log(`ALIAS "${r.input}" → ${r.zh}（${r.type === 'station' ? '车站' : '城市'}）· ${r.note}`);
  else if (r.verdict === 'ambiguous') console.log(`ALIAS "${r.input}" → ${r.candidates.join(' | ')}（${r.note}）`);
  else if (r.verdict === 'chinese') console.log(`ALIAS "${r.input}" → 已是中文，直接使用`);
  else console.log(`ALIAS "${r.input}" → 未收录（${r.note}）`);
  return 0;
}

process.exitCode = main(process.argv);
