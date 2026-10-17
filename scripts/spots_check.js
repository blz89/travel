#!/usr/bin/env node
/**
 * spots_check.js —— 景点预研数据门禁（**在预研子代理内部就跑，不要等生成 HTML 时才发现**）
 *
 * 为什么需要它：
 *   同一套规则原本只有 `make_html.js spots` 用到，**发现问题的时机太晚**——
 *   预研子代理已经结束、主流程才在生成 HTML 时炸，返工要跨进程重派子代理（贵）。
 *   本脚本与生成器**共用 lib/validate.js 的同一份实现**（零漂移），让子代理能在自己上下文里自查自改。
 *
 * 用法:
 *   node scripts/spots_check.js <景点数据.json>
 *
 * 退出码: 0 = PASS（可以交付）；1 = FAIL（逐条列出问题）
 *
 * 检查项（B1–B8；B1–B4/B6 与 make_html.js 同源）:
 *   B1 数量 5～10
 *   B2 配比：≥2 热门、保底 ≥2 不热门
 *   B3 网址形状闸门（政府信息公开·政务目录页 / 政务稿页 / 频道首页 / 携程系 / 短链 / 纯 IP 一律拒绝；
 *      文旅局 / 管委会 / 省政府的「概况·介绍」文章页是合格的）
 *   B4 字段完整（name / meta / urlLabel / url / source；good/bad ≤2；mine ≥1）
 *   B5 **开放时间或闭馆日**：meta 必须含开放时间形态，或显式写"以景区公示为准"
 *   B6 评价来源标注
 *   B7 封面卡与总览表数字一致（coverCards 里的统计不得与 overview.rows 实际条数矛盾）
 *   B8 网址评审：每条 url 必须与 spot_link.js 评审缓存一致（A/B 级、≤90 天；F 级要 urlFallback）
 *
 * 注意: 不要读本脚本源码——用 --help 就够了。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { validateData, OPEN_HOURS_RE, OPEN_HOURS_FALLBACK_RE } = require('./lib/validate');

const HELP = [
  'spots_check.js —— 景点预研数据门禁（预研子代理产出后必须跑，必须 exit 0）',
  '',
  '用法:',
  '  node scripts/spots_check.js <景点数据.json>    # 校验产出数据',
  '  node scripts/spots_check.js --need             # 只回答"要不要做景点预研"（派子代理之前跑）',
  '',
  '退出码: 0 = PASS；1 = FAIL（逐条列出）。FAIL 就自己改到过，不要把不合格的数据交回来。',
  '',
  '检查项:',
  '  B1 数量 5～10 个',
  '  B2 ≥2 热门、保底 ≥2 不热门（写在 meta 里）',
  '  B3 景点网址形状（只能是官网或马蜂窝/去哪儿/欣欣的该景点详情页）',
  '  B4 字段完整：name / meta / urlLabel / url / source；good / bad 各 ≤2；mine ≥1',
  '  B5 meta 必须含开放时间（如 "08:30-17:30" 或"全天"），或显式写"以景区公示为准"',
  '  B6 每条都要有评价来源（source）',
  '  B7 封面卡里的统计数字要与总览表实际条数一致',
  '  B8 网址评审：url 必须与 spot_link.js 评审缓存一致（A/B 级、评审 ≤90 天；F 级要 urlFallback）；',
  '     距到期不足 15 天只打 WARN（不阻断），提醒你跑 spot_link.js refresh 续期',
  '',
  '注意: 不要读本脚本源码——用 --help 就够了。',
].join('\n');

function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--help' || args[0] === '-h') { console.log(HELP); process.exit(0); }

  // --need：只回答"要不要做景点预研"，不校验文件。
  // 用途：**在派预研子代理之前**问一次——客户已明示不要景点时，整个子代理（¥0.13～0.21）都不该派出去。
  if (args.includes('--need')) {
    // 该脚本自身无法知道客户说了什么，只负责把决策口子开出来；
    // 上层（SKILL.md）在客户明确表示"不用做景点推荐/到此为止"时把它当 SKIP 信号。
    console.log('SPOT_NEED=ask  调用方按客户意图决定：');
    console.log('  · 客户**未**表示不需要景点 → SPOT_NEED=1，正常派预研子代理');
    console.log('  · 客户已表示不需要景点 / 到此为止 → SPOT_NEED=0，**不要派预研子代理**，直接按「收尾：一句话交还」收尾');
    process.exit(0);
  }

  const file = args[0];
  if (!file) { console.error('用法: node scripts/spots_check.js <景点数据.json>（--help 看完整说明）'); process.exit(1); }
  if (!fs.existsSync(file)) { console.error(`文件不存在: ${file}`); process.exit(1); }

  let d;
  try {
    // 容忍 UTF-8 BOM（PowerShell 写出的 JSON 常带 BOM）
    d = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch (e) {
    console.error(`JSON 解析失败: ${e.message}`);
    console.error('（若文件由 PowerShell 写出，可能带 BOM 或不是合法 JSON；请用 write 工具重写）');
    process.exit(1);
  }
  if (Array.isArray(d)) d = d[0] || {};
  if (!d || typeof d !== 'object') { console.error('数据顶层必须是对象（含 spots[]）'); process.exit(1); }

  const sp = Array.isArray(d.spots) ? d.spots : [];
  const line = [];
  const fail = [];
  const pass = [];
  const isStr = v => typeof v === 'string' && v.trim() !== '';

  // ---- B1 数量 ----
  if (sp.length >= 5 && sp.length <= 10) pass.push(`B1 数量 ${sp.length} 个（要求 5～10）`);
  else fail.push(`B1 数量 ${sp.length} 个 —— 要求 **5～10 个**；凑不齐按就近原则扩到同城/周边，超额删到 10 以内`);

  // ---- B2 配比 ----
  const isHot = s => /热门/.test(String(s.meta || '')) && !/不热门/.test(String(s.meta || ''));
  const hot = sp.filter(isHot).length;
  const cold = sp.filter(s => /不热门/.test(String(s.meta || ''))).length;
  if (hot >= 2 && cold >= 2) pass.push(`B2 热门 ${hot} / 不热门 ${cold}（要求 ≥2 / ≥2）`);
  else {
    if (hot < 2) fail.push(`B2 热门只有 ${hot} 个 —— 要求**至少 2 个热门**（在该景点 meta 里写明"热门"）`);
    if (cold < 2) fail.push(`B2 不热门只有 ${cold} 个 —— 要求**保底 2 个不热门**（在该景点 meta 里写明"不热门"）`);
  }

  // ---- B3 网址形状（与生成器同一份规则，见 lib/validate.js）----
  const badUrl = [];
  for (const s of sp) {
    // F 级降级（评审确认没有合格介绍页）时 url 允许为空，但必须写 urlFallback；由 B8 复核
    if (!isStr(s.url)) {
      if (!isStr(s.urlFallback)) badUrl.push(`${s.name || '?'}: url 缺失（F 级降级请写 urlFallback:"以景区公示为准"）`);
      continue;
    }
    if (!/^https?:\/\//.test(s.url)) { badUrl.push(`${s.name || '?'}: 不是 http(s) 网址 — ${s.url}`); continue; }
    // 复用生成器同一套规则：直接调 validateData 的单条判定会更绕，这里用其导出的规则表
  }
  // 用 validateData 一次性拿到全部问题，再按前缀归类（保证与生成器判定完全一致）
  const allErrs = validateData(d, 'spots');
  const urlErrs = allErrs.filter(e => /\.url 是「/.test(e) || /\.url 不是 http/.test(e) || /\.url 缺失/.test(e));
  // 去重：同一景点同一个原因只报一次（validateData 与本文件的形状检查会撞车）
  const b3 = [...new Set([...badUrl, ...urlErrs].map((x) => {
    const nm = (/([^：:]+)[：:]/.exec(x) || [])[1];
    const reason = /不是 http/.test(x) ? '不是http' : /缺失/.test(x) ? '缺失' : /是「/.test(x) ? '形状' : x;
    return nm ? nm.trim() + '|' + reason + '|' + x : 'raw|' + x;
  }))].map((k) => k.split('|').slice(2).join('|'));
  if (!b3.length) pass.push(`B3 ${sp.length} 条网址全部合规`);
  else fail.push(...b3.map(x => `B3 ${x}`));

  // ---- B4 字段 / B6 来源（同源；去掉已归入 B3 的 url 问题）----
  const otherErrs = allErrs.filter(e => !b3.includes(e) && !/\.meta 既没有开放时间/.test(e) && !/spots 有 \d+ 个|热门景点只有|不热门景点只有/.test(e));
  if (!otherErrs.length) pass.push('B4/B6 字段完整（name/meta/urlLabel/url/source；good/bad ≤2；mine ≥1）');
  else fail.push(...otherErrs.map(x => `B4/B6 ${x}`));

  // ---- B5 开放时间（本次新增的唯一规则）----
  const b5 = [];
  sp.forEach(s => {
    const meta = String(s.meta || '');
    if (!OPEN_HOURS_RE.test(meta) && !OPEN_HOURS_FALLBACK_RE.test(meta)) {
      b5.push(`B5 「${s.name || '?'}」meta 既没有开放时间（形如 "08:30-17:30" 或"全天"），也没写"以景区公示为准"` +
        `\n        meta 现值：${JSON.stringify(meta)}`);
    }
  });
  if (!b5.length) pass.push(`B5 ${sp.length} 个景点都写了开放时间或"以景区公示为准"`);
  else fail.push(...b5);

  // ---- B7 封面卡统计与总览表一致 ----
  // ⚠ 必须**按字段结构化**地读，不能把卡片展平成字符串再正则找"热门 N 个"：
  //   真实格式是 ["热门景点", "3 个", "..."]——标签与值**是两个字段**，展平后会连成
  //   "热门景点 3 个"，`/热门\s*(\d+)\s*个/` 根本匹配不到；而"含 3 个热门、2 个不热门"这种
  //   说明文字里数字在**前面**，顺序又相反。实测因此漏判（B7 形同虚设）。
  const num = v => { const m = /(\d+)/.exec(String(v == null ? '' : v)); return m ? Number(m[1]) : null; };
  const cards = (Array.isArray(d.coverCards) ? d.coverCards : []).map(c => {
    const t = Array.isArray(c) ? c : [c && (c.label ?? c.name), c && (c.value ?? c.val), c && (c.desc ?? c.note)];
    return { label: String(t[0] == null ? '' : t[0]), value: String(t[1] == null ? '' : t[1]), desc: String(t[2] == null ? '' : t[2]) };
  });
  const cardBy = re => cards.find(c => re.test(c.label));
  const b7 = [];
  // 「热门景点」卡：注意排除「不热门景点」
  const hotCard = cards.find(c => /热门/.test(c.label) && !/不热门/.test(c.label));
  const coldCard = cardBy(/不热门/);
  const totalCard = cardBy(/推荐景点|景点总数|推荐数量/);
  if (hotCard) {
    const n = num(hotCard.value);
    if (n !== null && n !== hot) b7.push(`B7 封面卡「${hotCard.label}」写 "${hotCard.value}"（${n} 个），但 meta 里实际热门 ${hot} 个`);
  }
  if (coldCard) {
    const n = num(coldCard.value);
    if (n !== null && n !== cold) b7.push(`B7 封面卡「${coldCard.label}」写 "${coldCard.value}"（${n} 个），但 meta 里实际不热门 ${cold} 个`);
  }
  if (totalCard) {
    const n = num(totalCard.value);
    if (n !== null && n !== sp.length) b7.push(`B7 封面卡「${totalCard.label}」写 "${totalCard.value}"（${n} 个），但 spots 实际 ${sp.length} 个`);
  }
  if (!cards.length) b7.push('B7 封面卡缺失（coverCards 为空或不是数组）—— 无法核对统计，这本身就是不合格数据');
  if (!b7.length) pass.push('B7 封面卡统计与总览表一致');
  else fail.push(...b7);

  // ---- B8 网址评审（每条 url 必须能在 spot_link.js 的评审缓存里对上号）----
  // 目的：不让模型"觉得这个网址不错"就挂上去 —— 交付的网址质量必须与已验收样本同级。
  const B8_MAX_AGE_DAYS = 90;
const B8_WARN_LEFT_DAYS = 15; // 距离过期不足这么多天就提醒（不阻断）
  const cacheFile = path.join(__dirname, '..', 'data', 'spots-links.json');
  let linkDb = {};
  try { linkDb = JSON.parse(fs.readFileSync(cacheFile, 'utf8').replace(/^\uFEFF/, '')); } catch (_) { linkDb = {}; }
  const b8 = [];
  const b8warn = [];
  const todayMs = Date.now();
  sp.forEach(s => {
    const nm = String(s.name || '?');
    const e = linkDb[nm];
    const hasUrl = isStr(s.url);
    if (!e) {
      if (!hasUrl && isStr(s.urlFallback)) {
        b8warn.push(`B8 「${nm}」没有评审记录，已按 F 级降级（url 空 + urlFallback）—— 能交付但不算"已评审"；有空补跑 resolve --cache`);
        return;
      }
      b8.push(`B8 「${nm}」没有经过网址评审 —— 先跑 node scripts/spot_link.js resolve --name "${nm}" --url <候选1> --url <候选2> --cache`);
      return;
    }
    // checkedAt 正常是 spot_link.js 写的 "YYYY-MM-DD"；也容忍完整 ISO（手写 / 旧版缓存）：
    // 统一截到日期再按 UTC 零点算，避免 "…T13:52:31.768Z" 拼上 'T00:00:00Z' 变 NaN 被误判过期。
    const cAt = String(e.checkedAt || '').slice(0, 10);
    const parsedAt = Date.parse(cAt + 'T00:00:00Z');
    const ageDays = Number.isFinite(parsedAt) ? Math.floor((todayMs - parsedAt) / 86400000) : NaN;
    if (!Number.isFinite(ageDays)) {
      b8.push(`B8 「${nm}」的评审记录 checkedAt 格式不对（"${e.checkedAt}"）—— 应为 YYYY-MM-DD，重跑 node scripts/spot_link.js resolve … --cache`);
      return;
    }
    if (!(ageDays >= 0 && ageDays <= B8_MAX_AGE_DAYS)) {
      b8.push(`B8 「${nm}」的网址评审已过期（checkedAt=${cAt}，距今 ${ageDays} 天，上限 ${B8_MAX_AGE_DAYS} 天）—— 重跑 node scripts/spot_link.js refresh`);
      return;
    }
    const leftDays = B8_MAX_AGE_DAYS - ageDays;
    if (leftDays <= B8_WARN_LEFT_DAYS) b8warn.push(`B8 「${nm}」的网址评审还有 ${leftDays} 天到期（checkedAt=${cAt}）—— 到期后 B8 会直接 FAIL，届时跑 node scripts/spot_link.js refresh`);
    if (e.grade === 'A' || e.grade === 'B') {
      if (!hasUrl) b8.push(`B8 「${nm}」评审等级 ${e.grade} 但 url 为空 —— 应填 ${e.intro}`);
      else if (s.url !== e.intro) b8.push(`B8 「${nm}」url 与评审结果不一致：数据里是 ${s.url}，评审认定的是 ${e.intro}`);
    } else {
      // F 级：评审确认"没有合格介绍页"，此时必须如实降级，不许硬挂链接
      if (hasUrl) b8.push(`B8 「${nm}」评审等级 F（${e.reason}），但数据里仍填了 url —— 清空 url 并写 urlFallback:"以景区公示为准"`);
      else if (!isStr(s.urlFallback)) b8.push(`B8 「${nm}」评审等级 F，url 留空时必须写 urlFallback:"以景区公示为准"`);
    }
  });
  if (!b8.length) pass.push(`B8 ${sp.length} 条网址都过了评审（等级/时效/一致性${b8warn.length ? '；' + b8warn.length + ' 条临期' : ''}）`);
  else fail.push(...b8);

  // ---- 输出 ----
  const total = pass.length + fail.length;
  console.log(`spots_check: ${pass.length} PASS / ${fail.length} FAIL / ${b8warn.length} WARN（共 ${total} 项）`);
  pass.forEach(p => console.log(`  PASS ${p}`));
  b8warn.forEach(w => console.log(`  WARN ${w}`));
  fail.forEach(f => console.log(`  FAIL ${f}`));
  if (fail.length) {
    console.log('');
    console.log('→ 请按上面每条修好数据后**重跑本命令**，必须 exit 0 再交回；');
    console.log('  查不到的信息如实写"以景区公示为准 / 未找到官网 / 公开评论较少"，不得编造。');
  }
  process.exit(fail.length ? 1 : 0);
}

main();
