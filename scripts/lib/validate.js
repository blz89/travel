/**
 * 景点数据校验（唯一实现，禁止在别处再写一遍）
 *
 * 为什么要单独成文件：同一套规则原来只有 `make_html.js spots` 用到，**发现问题的时机太晚**——
 * 预研子代理已经结束、主流程才在生成 HTML 时炸，返工要跨进程重派子代理。
 * 现在 `scripts/spots_check.js` 与 `make_html.js` **共用本文件**，子代理可以在自己上下文里自查自改。
 *
 * ⚠ 改动本文件会同时影响「预研门禁」与「HTML 生成」两处，这是**有意为之**（防两份实现漂移）。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

// ---------- 通用小工具（make_html.js 的渲染也要用）----------
// legs[].*-style 前缀剥离：模型常把标签写进内容里，渲染会变成「打车约 打车备选 9 km」这种重复字
const LEAD_LABELS = /^(?:全程打车备选|全程打车|打车备选|打车约|公交\+打车|车程|行车路线|备选路线|打车)(?=[\s：:，,]|$)[\s：:，,]*/;
function stripLead(v, label) {
  let t = String(v == null ? '' : v).trim();
  if (label && t.startsWith(label)) t = t.slice(label.length).replace(/^[：:\s]+/, '').trim();
  for (let i = 0; i < 3 && LEAD_LABELS.test(t); i++) t = t.replace(LEAD_LABELS, '').trim();
  return t;
}
function legNo(n, fallback) {
  const t = String(n == null ? '' : n).replace(/^第\s*/, '').replace(/\s*段\s*$/, '').trim();
  return t || String(fallback);
}
// coverCards 容错：["标签","值","说明"] 数组与 {label,value,desc} 对象都接受。
// 实测中两组都踩过——SKILL.md 只说"每张 3 项"，模型按字面写成对象就被拒；
// 生成器自己兜住，别让它靠报错重试（重试放大的代价远高于这里多几行）。
function card3(c) {
  if (Array.isArray(c)) return c;
  if (c && typeof c === 'object') {
    const pick = (...keys) => { for (const k of keys) if (c[k] !== undefined) return c[k]; return undefined; };
    return [pick('label', 'name', 0), pick('value', 'val', 1), pick('desc', 'note', 'text', 'sub', 2)];
  }
  return null;
}
// legs[].km 容错：给数字就按 km 处理（实测给数字会被拒）
const kmText = v => (Number.isFinite(v) ? `${v} km` : v);

// ---------- 景点网址的「形状闸门」----------
// 只能保证「这是一张稳定的景点直达页」，**不能**证明「这真的是那个景点」——语义正确性仍靠执行者。
// 依据：真实跑出来的错例（把政务网稿页/信息公开页/频道首页当景点网址）几乎都是形状出卖的。
const URL_SHAPE_RULES = [
  ['短链 / 跳转站', u => /^https?:\/\/(bit\.ly|t\.cn|dwz\.cn|url\.cn|suo\.im|sourl\.cn)\//i.test(u)],
  ['纯 IP 地址', u => /^https?:\/\/\d{1,3}(\.\d{1,3}){3}/.test(u)],
  ['反爬 / 验证特征', u => /verify|security|robot|captcha|antibot/i.test(u)],
  ['反爬常客（百科/知道/经验，正文拿不到）', u => /(baike|zhidao|jingyan)\.baidu\.com/i.test(u)],
  ['携程系（trip.com / ctrip.com）', u => /(^|\.)(trip\.com|ctrip\.com)/i.test(u)],
  ['政府 CMS 日期稿件页（如 …gov.cn/t20220421_5692516.shtml）', u => {
    // 只针对政府站：央媒/景区站也用 /t2025xxxx_xxxx.html 这种路径（人民画报即如此），不该冤枉
    let host = '';
    try { host = new URL(u).hostname; } catch (_) { return false; }
    return /\.gov\.cn$/.test(host) && /\/t\d{8}_\d+\.s?html?$/i.test(u);
  }],
  ['政府信息公开 / 政务目录页', u => /\/(xxgk|bmxxgkmlx?|xxgkml|zwgk|zwxx|gkml|zfxxgk)\w*\//i.test(u)],
  ['频道 / 栏目首页', u => /\/(cindex|index|list|channel|column)\.?\w*$/i.test(u)],
];
const urlShapeFail = u => {
  for (const [name, f] of URL_SHAPE_RULES) if (f(u)) return name;
  return null;
};

// 「频道/栏目首页」「政府 CMS 日期稿件页」原本一刀切，但许多景区官网只有这类页面承载
// 景区介绍（实测：张家界官网 /index.php/Article/list/11.html，要点 28、汉字 5815、图 36）。
// 单一真源 = spot_link.js 的评审结论：**评审判 A/B 就放行**，判 weak/F 才拦。
const REVIEW_EXEMPT = new Set(['频道 / 栏目首页', '政府 CMS 日期稿件页']);
let __spotsCache = null;
let __spotsCacheMtime = 0;
function loadSpotsCache() {
  // 按 mtime 失效：同一进程里先跑 spot_link 再跑校验也能读到最新评审结果
  try {
    const p = path.join(__dirname, '..', '..', 'data', 'spots-links.json');
    const m = fs.statSync(p).mtimeMs;
    if (!__spotsCache || m !== __spotsCacheMtime) {
      __spotsCache = JSON.parse(fs.readFileSync(p, 'utf8'));
      __spotsCacheMtime = m;
    }
    return __spotsCache;
  } catch (_) { __spotsCache = {}; return __spotsCache; }
}
function reviewGrade(name, url) {
  const __spotsCache = loadSpotsCache();
  const e = __spotsCache[String(name || '').trim()];
  if (!e) return null;
  if (!['A', 'B'].includes(String(e.grade))) return null;
  return String(e.intro || '') === String(url || '') ? String(e.grade) : null;
}

// 开放时间形态：08:30-17:30 / 08:30–17:30 / 08:30~17:30 / 08:30至17:30，或「全天」
const OPEN_HOURS_RE = /\d{1,2}:\d{2}\s*[-–—~至]\s*\d{1,2}:\d{2}|全天/;
// 查不到时的显式兜底写法（B5：二者必居其一）
const OPEN_HOURS_FALLBACK_RE = /以景区公示为准/;

// 价格必须标明票种（铁路席别 / 空中舱位）。**"票价待定/以出票页为准"这类无价格文案豁免**。
const SEAT_KIND_RE = /二等座|一等座|商务座|特等座|硬座|硬卧|软卧|高级软卧|软座|硬卧|无座|经济舱|公务舱|头等舱|超经|机票/;
// 「没有数字」= 不是报价，而是说明文字（如"票价待定，以出票页为准"）→ 不要求标票种
const HAS_PRICE_NUM_RE = /\d/;

// ---------- 数据校验（先校验再渲染：缺字段就报可读错误，不产出半成品、不抛堆栈）----------
function validateData(d, mode) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return ['数据根节点必须是 JSON 对象（顶层应是 { … }，不是数组 / null）'];
  const errs = [];
  const isStr = v => typeof v === 'string' && v.trim() !== '';
  const arr = v => (Array.isArray(v) ? v : null);
  const nonEmpty = v => (arr(v) || []).filter(isStr);

  if (!isStr(d.coverTitle) && !isStr(d.title)) errs.push('缺少 coverTitle（封面主标题）');
  const cc = arr(d.coverCards);
  if (!cc || !cc.length) errs.push('coverCards 缺失或为空（封面至少 1 张数据卡）');
  else cc.forEach((c, i) => {
    const t = card3(c);
    if (!t || t.length < 3) errs.push(`coverCards[${i}] 需要 3 项：标签 / 值 / 说明（写 ["标签","值","说明"] 数组，或 {label,value,desc} 对象都行）`);
    else if (t.slice(0, 3).some(v => String(v == null ? '' : v).trim() === '')) {
      errs.push(`coverCards[${i}] 有空白项（标签 / 值 / 说明 都要写）`);
    }
  });

  if (!d.overview || !nonEmpty((d.overview.rows || []).flat()).length) {
    errs.push('overview.rows 缺失或为空（决策速览/总览表至少要有一行数据）');
  }

  if (mode === 'plan') {
    // A2 价格必须标票种（硬性）：每一个价格都要带席别/舱位，否则客户无法判断"这是哪个票种的价"。
    // 豁免：不含数字的说明文案（"票价待定，以出票页为准"）—— 它不是报价。
    //
    // ⑤ **方案块内已写明票种**也豁免（2026-09-26 A/B 实测新增）：
    //    拼票方案的人均价天然是"二等座 + 一等座"的混合价，写不进单一票种；技能允许把票种写在
    //    **方案标题**里（"高铁 G1523 直达（拼票：二等座 1 张 + 一等座 1 张）"）。
    //    旧规则只认价格字段本身，于是把这种合规写法判成"未标票种"，逼执行者回头改数据再重生成
    //    —— 一次白跑的生成 + 若干次 edit。判定改为**看整张方案卡**：同块内任何位置写了票种即算写明。
    const blockSeatKind = (p) => {
      if (!p) return false;
      const parts = [p.title, p.subtitle, p.badge];
      for (const s of arr(p.steps) || []) if (s) parts.push(s.desc, s.place, s.time);
      for (const r of arr(p.costRows) || []) {
        if (Array.isArray(r)) parts.push(...r);
        else if (r) parts.push(r.label ?? r.name, r.value ?? r.val);
      }
      return SEAT_KIND_RE.test(parts.filter(isStr).join(' '));
    };
    const checkPriceKind = (txt, tag, blockHasKind = false) => {
      if (!isStr(txt)) return;
      if (!HAS_PRICE_NUM_RE.test(txt)) return;          // 无数字 = 说明文字，豁免
      if (SEAT_KIND_RE.test(txt)) return;
      if (blockHasKind) return;                          // ⑤ 同块内已写明票种
      errs.push(`${tag} 报价未标明票种：「${txt}」——每个价格都要写清席别（二等座/硬卧…）或舱位（经济舱）；` +
        `票种由「席别规则」定，不需要客户自己比价`);
    };
    const checkPlans = (node, label) => {
      if (!node) return;
      const ps = arr(node.plans);
      if (!ps || !ps.length) { errs.push(`${label}.plans 缺失或为空`); return; }
      ps.forEach((p, i) => {
        const tag = `${label}.plans[${i}]`;
        const blockHasKind = blockSeatKind(p);
        if (!isStr(p.title)) errs.push(`${tag}.title 缺失`);
        checkPriceKind(p.price, `${tag}.price`, blockHasKind);
        if (!arr(p.steps) || !p.steps.length) errs.push(`${tag}.steps 缺失或为空`);
        else p.steps.forEach((s, j) => {
          if (!isStr(s.time) || !isStr(s.place) || !isStr(s.desc)) {
            errs.push(`${tag}.steps[${j}] 需要 time / place / desc 三项`);
          }
        });
        if (!arr(p.costRows) || !p.costRows.length) errs.push(`${tag}.costRows 缺失或为空`);
        else p.costRows.forEach((row, j) => {
          // costRows 的票种判定要**看标签+值两列**，不能只看值：
          //   ["G2911 二等座", "¥250.0"]  ← 票种在标签里（技能就是这么规定的：首行标签写"车次 + 席别 + 票价"）
          //   ["合计", "¥800.0"]          ← 合计/接驳/附加费**本来就不带票种**，必须豁免
          // 只在「标签既没带票种、也不是合计/费用类」时才要求值里有票种。
          const label = String((Array.isArray(row) ? row[0] : row && (row.label ?? row.name)) ?? '');
          const val = String((Array.isArray(row) ? row[1] : row && (row.value ?? row.val)) ?? '');
          const AGG = /合计|小计|总计|总共|接驳|打车|地铁|公交|步行|机场建设费|机建|燃油|附加费|服务费|住宿|餐|人均/;
          const labelHasKind = SEAT_KIND_RE.test(label);
          if (labelHasKind || AGG.test(label)) return;        // 豁免
          // ⑤ 的"块级豁免"**只给综合行**（无班次号的合计 / 组合 / 拼票行）——那种行的价天然是混合价，
          //    写不出单一票种，只能靠整卡的说明。但**带班次号的行是"某一段自己的价"**，必须自己标票种；
          //    否则"某一段没写票种"会被整卡别处的票种说明**掩盖过去**
          //    （真实的洞：一张卡里高铁那行写了二等座，机票那行就裸着也过关）。
          const rowIsLeg = /\b(?:[GDCZTK]\d{1,4}|[A-Z]{2}\d{3,4})\b/.test(label);
          checkPriceKind(val, `${tag}.costRows[${j}]`, blockHasKind && !rowIsLeg);
        });
      });
    };
    checkPlans(d.cheapest, 'cheapest');
    checkPlans(d.extra, 'extra');
    if (d.fastest && (!arr(d.fastest.steps) || !d.fastest.steps.length)) {
      errs.push('fastest.steps 缺失或为空');
    }
    // fastest 也要 costRows：缺了会渲染出「只有标题、没有一行费用」的空费用卡（且旧版校验器与空壳检查都抓不到）
    if (d.fastest && (!arr(d.fastest.costRows) || !d.fastest.costRows.length)) {
      errs.push('fastest.costRows 缺失或为空（会渲染出只有标题的空「费用明细」卡）');
    }
    if (d.fastest) checkPriceKind(d.fastest.price, 'fastest.price', blockSeatKind(d.fastest));

    // A4 三段数量（硬性）：最省钱 1 个 + 最快 1 个 + 额外 ≥2 个。
    // 额外不足 2 个时**必须有解释**（注明原因），否则客户会以为我们没查全。
    if (d.cheapest) {
      const cps = arr(d.cheapest.plans) || [];
      if (cps.length > 1) {
        errs.push(`cheapest.plans 有 ${cps.length} 个 —— 「最省钱」**只放 1 个**；比它贵但仍有价值的方案放「额外方案」（硬性：1 + 1 + ≥2）`);
      }
    }
    const exs = d.extra ? (arr(d.extra.plans) || []) : [];
    if (exs.length < 2) {
      const notesTxt = [
        ...(arr(d.overview && d.overview.footnotes) || []),
        ...(d.overview && isStr(d.overview.note) ? [d.overview.note] : []),
        ...(d.extra && arr(d.extra.footnotes) || []),
      ].join(' ');
      const explained = /余票不足|余票不够|票不够|无票|班次太少|查不到代号|航班号|窗口内无|无法给出|只有这些/.test(notesTxt);
      if (!explained) {
        errs.push(`extra.plans 只有 ${exs.length} 个（要求 ≥2）——**给不满必须在注脚里写明原因**` +
          `（余票不足 / 无票 / 班次太少 / 航班查不到代号 / 窗口内无班次），否则客户会以为没查全`);
      }
    }
  }

  if (mode === 'spots') {
    const sp = arr(d.spots);
    if (!sp || !sp.length) errs.push('spots 缺失或为空');
    else sp.forEach((s, i) => {
      const tag = `spots[${i}]${isStr(s.name) ? '（' + s.name + '）' : ''}`;
      if (!isStr(s.name)) errs.push(`${tag}.name 缺失`);
      if (!isStr(s.meta)) errs.push(`${tag}.meta 缺失`);
      else if (!OPEN_HOURS_RE.test(s.meta) && !OPEN_HOURS_FALLBACK_RE.test(s.meta)) {
        // B5：开放时间/闭馆日是必查项；查不到也必须**显式**写兜底，不许留空
        errs.push(`${tag}.meta 既没有开放时间（形如 "08:30-17:30" 或"全天"），也没写"以景区公示为准"` +
          ` —— 开放时间与闭馆日是必填信息，查不到就如实写"以景区公示为准"。meta 现值：${JSON.stringify(s.meta)}`);
      }
      if (!isStr(s.urlLabel)) errs.push(`${tag}.urlLabel 缺失`);
      // url 可以为空，但**仅在**评审判定 F 级、且显式写了降级文案时（"以景区公示为准"）
      const hasFallback = isStr(s.urlFallback);
      if (!isStr(s.url)) {
        if (!hasFallback) errs.push(`${tag}.url 缺失 —— 若 spot_link.js 评审为 F 级，请写 urlFallback:"以景区公示为准"`);
      } else if (!/^https?:\/\//.test(s.url)) errs.push(`${tag}.url 不是 http(s) 网址：${s.url}`);
      else {
        let bad = urlShapeFail(s.url);
        if (bad && REVIEW_EXEMPT.has(bad) && reviewGrade(s.name, s.url)) bad = null; // 评审 A/B 豁免栏目页/日期稿件页
        if (bad) {
          errs.push(`${tag}.url 是「${bad}」，不能作为景点网址：${s.url}` +
            ` —— 景点只给**一条**「当地文旅局 / 景区管委会 / 景区官网的概况·介绍页」，` +
            `且必须过 \`node scripts/spot_link.js resolve --name "<景区名>" --url <候选…> --cache\` 评审（spots_check B8 复核）；` +
            `拿不到合格页就 url 留空 + urlFallback:"以景区公示为准"，不得拿反爬页 / 信息公开页 / 栏目首页 / 携程系充数`);
        }
      }
      // 三轨链接（可选）：official = 须知/公告页，photo = 图集页。
      // 只要给了就必须是稳定直达页，规则与 url 同一套 —— 版本页/栏目首页/政府信息公开页一律不认。
      for (const k of ['official', 'photo']) {
        if (s[k] === undefined || s[k] === null || s[k] === '') continue;
        const v = String(s[k]).trim();
        if (!/^https?:\/\//.test(v)) { errs.push(`${tag}.${k} 不是 http(s) 网址：${v}`); continue; }
        let bad = urlShapeFail(v);
        if (bad && REVIEW_EXEMPT.has(bad) && reviewGrade(s.name, v)) bad = null;
        if (bad) errs.push(`${tag}.${k} 是「${bad}」，不能作为景点链接：${v} —— 换景区官网/文旅局介绍页/公告页；拿不到就留空`);
      }
      // 门票三态（可选）：paid / free / free_with_fee_parts（后者必须列收费子景点）。
      // 只回答“要不要买票”，不写票价 —— 客户口径是只算车费。
      if (s.ticket !== undefined && s.ticket !== null) {
        const st = typeof s.ticket === 'string' ? s.ticket : s.ticket.status;
        if (!['paid', 'free', 'free_with_fee_parts'].includes(st)) {
          errs.push(`${tag}.ticket 状态必须是 paid / free / free_with_fee_parts 之一（当前 ${JSON.stringify(st)}）`);
        } else if (st === 'free_with_fee_parts' && nonEmpty(s.ticket.parts).length === 0) {
          errs.push(`${tag}.ticket 为 free_with_fee_parts 时必须列 parts（园区免费、但园中园/索道等另收费的子景点名）`);
        }
      }
      // 好评 / 差评：最多 2 条；公开评论确实很少时允许 1 条甚至 0 条（如实呈现，不得编造）
      for (const k of ['good', 'bad']) {
        if (nonEmpty(s[k]).length > 2) errs.push(`${tag}.${k} 最多 2 条（当前 ${nonEmpty(s[k]).length} 条）`);
      }
      if (nonEmpty(s.mine).length < 1) errs.push(`${tag}.mine 至少 1 条`);
      {
        // 「我的点评」是这一页唯一有人味的部分：太短就成了复述 meta。要求合计 >= 24 字。
        const mineTxt = nonEmpty(s.mine).map((x) => String(x).trim()).join("");
        if (mineTxt.length < 24) errs.push(`${tag}.mine 太短（合计 ${mineTxt.length} 字）——「我的点评」至少 24 字：一条判断 + 一个具体画面或取舍理由；可以幽默、口语，但不得编事实`);
      }
      if (!isStr(s.source)) errs.push(`${tag}.source 缺失（评价来源标注是硬性要求，见「流程二」步骤 4）`);
    });
    // 数量与配比：技能硬性要求（5～10 个 / ≥2 热门 / 保底 2 不热门）。
    // 从前只靠子代理自己数、自己写进自检结论，生成器不拦——**枚举就该由代码做**。
    if (sp) {
      if (sp.length < 5 || sp.length > 10) {
        errs.push(`spots 有 ${sp.length} 个，技能要求 **5～10 个**——凑不齐就按「流程二」步骤 1 的就近原则扩到同城/周边，超额就删到 10 个以内`);
      }
      const isHot = s => /热门/.test(String(s.meta || '')) && !/不热门/.test(String(s.meta || ''));
      const hot = sp.filter(isHot).length;
      const cold = sp.filter(s => /不热门/.test(String(s.meta || ''))).length;
      if (hot < 2) errs.push(`热门景点只有 ${hot} 个，技能要求**至少 2 个热门**（在对应景点的 meta 里写明"热门"）`);
      if (cold < 2) errs.push(`不热门景点只有 ${cold} 个，技能要求**保底 2 个不热门**（在对应景点的 meta 里写明"不热门"）`);
    }
  }

  if (mode === 'itin') {
    const lg = arr(d.legs);
    if (!lg || !lg.length) errs.push('legs 缺失或为空');
    else lg.forEach((l, i) => {
      if (!isStr(l.from) || !isStr(l.to)) errs.push(`legs[${i}] 缺少 from / to`);
      if (!isStr(l.km) && !Number.isFinite(l.km)) errs.push(`legs[${i}] 缺少 km（每段都要写清里程；写数字 15.3 或 "15.3 km" 都行）`);
      // note 可选：渲染器按「非空部分拼接」处理，留空不会留下悬空的「 · 」
    });
    if (d.plans) {
      const cards = Array.isArray(d.plans) ? d.plans : (arr(d.plans.cards) || []);
      cards.forEach((c, i) => {
        if (!isStr(c.title)) errs.push(`plans[${i}].title 缺失`);
        // `rows` 可以不给：给了 `mode`（taxi / bus / mixed）时**生成器会从 legs[] 推出明细行**
        // （省掉把同一份信息手写两遍：方案卡的逐段明细与 legs[].bus/taxi 本来就是同一份内容）。
        const hasMode = isStr(c.mode);
        if ((!arr(c.rows) || !c.rows.length) && !hasMode) {
          errs.push(`plans[${i}].rows 缺失或为空（也可给 \`mode:"taxi"|"bus"|"mixed"\` 让生成器从 legs[] 自动生成明细行）`);
        }
        if (hasMode && !/^(taxi|bus|mixed)$/i.test(String(c.mode))) {
          errs.push(`plans[${i}].mode 只能是 taxi / bus / mixed（当前：${c.mode}）`);
        }
      });
    }
  }
  if (mode === 'drive') {
    // 自驾路线讲解页：**截图必须真的存在**——否则页面里会嵌一个坏图 / 抛异常，
    // 而 A5（空占位）抓不到"图没加载"这种失败。这里当场拦，报可读错误。
    // 图可以放在顶层 `map`，也可以放在 `sections[].type === "map"`（后者更常见）。
    const maps = [d.map, ...((arr(d.sections) || []).filter(s => s.type === 'map'))].filter(Boolean);
    if (!maps.length) errs.push('缺地图截图：给 sections[] 里一个 `type:"map"` 的章节（或顶层 map 对象），并填 image 路径');
    maps.forEach(m => {
      if (!isStr(m.image)) errs.push('地图章节缺 image（填截图文件路径，如 "_work/路线图.jpg"）');
      else if (!fs.existsSync(path.resolve(m.image))) errs.push(`地图截图文件不存在：${m.image}`);
    });
    // 车辆类型分流：客户 2026-10-17「如果不是电车可没有服务区推荐哦」。
    // `vehicle` 缺省按电车（旧数据兼容）；写「油车」→ 充电规划整节不做、讲解页也不许出现充电内容。
    const isEV = !/油/.test(String(d.vehicle || '电车'));
    const CHG = /充电|充电桩|快充|超充|换电/;
    if (isEV) {
      if (!arr(d.waypoints) || !d.waypoints.length) errs.push('waypoints 缺失或为空（电车充电清单：第一行是表头）');
      else if (d.waypoints.length < 2) errs.push('waypoints 至少要有「表头 + 1 行充电点」');
      // 第 2 页＝纯「电车充电清单」：客户 2026-10-17「拥堵路段和充电服务区分开，第二页混在一起太乱」。
      // 拥堵的下/上高速口只能进第③段 table（下高速口/上高速口 列），不许混进充电表。
      const WPMIX = /收费站|高速口|下高速|上高速|互通|匝道/;
      const wpBad = (arr(d.waypoints) || []).slice(1).map((r, i) => ({ r, i })).filter(o => (arr(o.r) || []).some(c => WPMIX.test(String(c))));
      if (wpBad.length) errs.push(`waypoints（第 2 页充电清单）第 ${wpBad[0].i + 2} 行混进了拥堵/收费站信息：第 2 页只放电车充电服务区（里程/服务区/本段里程/桩/备注），拥堵的「下口/上口」请放第③段 table 的下高速口、上高速口列（客户 2026-10-17）`);
    } else {
      if (arr(d.waypoints) && d.waypoints.length > 1) errs.push('车辆类型＝油车，不该有充电清单（waypoints 只留表头或整段省略）——客户 2026-10-17：「如果不是电车可没有服务区推荐哦」');
      const allTxt = JSON.stringify([d.coverTitle, d.coverSubtitle, d.coverNote, d.coverCards, d.overview, d.footnotes, d.waypoints, d.sections]);
      if (CHG.test(allTxt)) errs.push('车辆类型＝油车，讲解页里出现了「充电／充电桩／快充／超充／换电」字样：油车不做充电点、不推荐服务区（客户 2026-10-17）');
    }
    (arr(d.sections) || []).forEach((s, i) => {
      if (!isStr(s.id) || !isStr(s.title) || !isStr(s.type)) { errs.push(`sections[${i}] 需要 id / title / type`); return; }
      if (!/^(map|waypoints|table|grid3|notes|sources)$/.test(String(s.type))) {
        errs.push(`sections[${i}].type 只能是 map / waypoints / table / grid3 / notes / sources（当前：${s.type}）`);
      }
      if (s.type === 'map' && !isStr(s.image)) errs.push(`sections[${i}]（map）缺 image`);
      if (s.type === 'table' && (!arr(s.rows) || !s.rows.length)) errs.push(`sections[${i}]（table）缺 rows`);
      if (s.type === 'grid3' && (!arr(s.cards) || !s.cards.length)) errs.push(`sections[${i}]（grid3）缺 cards`);
      if ((s.type === 'notes' || s.type === 'sources') && (!arr(s.items) || !s.items.length)) errs.push(`sections[${i}]（${s.type}）缺 items`);
    });
    // 避堵证据链（硬性，见 references/driving-route-planning.md §1 ⑥）：
    // 没有证据不许下避堵结论 → 页面必须自带「方案 × 段落 × 依据 × 来源年份 × 预案」的证据表、
    // 「未获取项」和「出发当天复核清单」，且不得出现断言式避堵用语。
    const tables = (arr(d.sections) || []).filter(s => s.type === 'table');
    const evidence = tables.find(s => {
      const head = (arr(s.head) || []).join(' ');
      return /依据/.test(head) && /预案/.test(head);
    });
    if (!evidence) errs.push('缺「避堵证据表」：需要一个 table 章节，表头含 依据 / 预案（driving-route-planning.md §1 ⑥）');
    else {
      const cols = (arr(evidence.head) || []).length;
      if (cols < 4) errs.push(`避堵证据表列数不足（${cols} 列）：至少要 节点 / 路段 / 依据 / 预案`);
      const rows = arr(evidence.rows) || [];
      if (rows.length < 2) errs.push('避堵证据表至少要有「1 个可能拥堵节点 + 未被点名的说明」两行（没被点名的也要列，写"未发现被点名路段"）');
      const hasUnnamed = rows.some(r => (arr(r) || []).some(c => /未发现被点名|未获取/.test(String(c))));
      if (!hasUnnamed) errs.push('避堵证据表里必须有"未发现被点名路段 / 未获取"的行或列（§1 硬闸门：没证据只能这么写）');
      // 标了「精细化」的节点，必须各有一张对应的地图章节（§1 ⑤）；"不出精细化"这类否定写法不计入
      const fineCount = rows.filter(r => (arr(r) || []).some(c => {
        const s = String(c);
        return /精细化/.test(s) && !/不[出做需]精细化|无需精细化/.test(s);
      })).length;
      const allMaps = [d.map, ...((arr(d.sections) || []).filter(s => s.type === 'map'))].filter(Boolean);
      // 总览图 = 顶层 d.map 优先，否则第一张 map 章节；其余都按「节点精细化图」校验
      const overviewMap = d.map && typeof d.map === 'object' ? d.map : allMaps[0];
      const fineMaps = allMaps.filter(m => m !== overviewMap);
      if (allMaps.length < 1 + fineCount) {
        errs.push(`缺节点精细化地图：证据表标了 ${fineCount} 个节点要精细化，页面只有 ${Math.max(0, allMaps.length - 1)} 张节点图（每个这样的节点各须一张，§1 ⑤）`);
      }
      fineMaps.forEach((s, i) => {
        if (!isStr(s.note) || s.note.trim().length < 8) {
          errs.push(`第 ${i + 2} 张地图是节点精细化图，必须有 note 写清怎么绕（从哪个口下、走哪条路、从哪个口上、什么程度触发）`);
        }
      });
    }
    const notesTxt = (arr(d.sections) || []).filter(s => s.type === 'notes').flatMap(s => arr(s.items) || []).join(' ');
    if (!/未获取|未发现被点名/.test(notesTxt)) errs.push('缺「未获取项清单」：notes 章节里要逐条写明缺什么证据（§1 ⑥）');
    if (!/复核/.test(notesTxt)) errs.push('缺「出发当天复核清单」：notes 章节里要写清当天按哪条路逐段看实时路况、什么程度触发哪个下道口（§1 ⑥）');
    // 有卡点时，notes 必须写清「严重度」怎么分级（总览图上深浅红的含义）
    if (!/严重度/.test(notesTxt)) {
      errs.push('notes 必须写「严重度」一档（拥堵点的分级口径：命中次数/出发年是否被点名，总览图上的深浅红或红点分别代表什么）');
    }
    const raw = JSON.stringify(d);
    for (const bad of ['已避开拥堵', '全程无堵', '保证不堵', '零拥堵']) {
      if (raw.includes(bad)) errs.push(`禁止断言「${bad}」：没有证据不许下避堵结论（§1 硬闸门）`);
    }
  }
  return errs;
}

module.exports = { validateData, stripLead, legNo, card3, kmText, urlShapeFail, URL_SHAPE_RULES, OPEN_HOURS_RE, OPEN_HOURS_FALLBACK_RE };
