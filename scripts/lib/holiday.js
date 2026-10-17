/**
 * lib/holiday.js —— 节假日判定的**唯一实现**（dateinfo.js 与 hours_check.js 共用）
 *
 * 为什么单独抽出来：节假日判定原本有两处——dateinfo.js 算、hours_check.js 靠调用方
 * 用 `--holiday` 手工传布尔值。同一事实两个真源，必然漂移（模型漏传就判错）。
 * 现在：数据 + 判定只在这里，两个脚本都调它。
 *
 * 数据: data/holidays-cn.json（只认官方通知；published=false 的年份按固定公历日兜底，certainty=low）
 */
const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, '..', '..', 'data', 'holidays-cn.json');
const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const DAY = 24 * 3600 * 1000;

let cache = null;
function load() {
  if (cache) return cache;
  cache = JSON.parse(fs.readFileSync(DATA, 'utf8').replace(/^\uFEFF/, ''));
  return cache;
}

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const parse = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s).trim());
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  return Number.isNaN(d.getTime()) ? null : d;
};
const addDays = (d, n) => new Date(d.getTime() + n * DAY);
const span = (from, to) => Math.round((parse(to).getTime() - parse(from).getTime()) / DAY);

function infoFor(dateStr, windowN = 1, data = load()) {
  const d = parse(dateStr);
  if (!d) throw new Error('日期格式应为 YYYY-MM-DD：' + dateStr);
  const year = d.getFullYear();
  const y = data.years && data.years[String(year)];
  const published = !!(y && y.published);
  const list = (published ? y.holidays : []).map((h) => ({ ...h, fromD: parse(h.from), toD: parse(h.to) }));
  const certainty = published ? 'official' : 'low';

  if (!published) {
    for (const f of data.fallbackFixedDays || []) {
      if (d.getMonth() + 1 === f.month && d.getDate() >= f.fromDay && d.getDate() <= f.toDay) {
        list.push({ name: f.name, from: ymd(d), to: ymd(d), fromD: new Date(d), toD: new Date(d) });
      }
    }
  }
  const hit = list.find((h) => d >= h.fromD && d <= h.toD) || null;
  const adjustWorkday = !!(published && (y.workdays || []).includes(ymd(d)));

  let windowHit = !!hit;
  let windowName = hit ? hit.name : '';
  if (!hit && windowN > 0) {
    for (const h of list) {
      if (d >= addDays(h.fromD, -windowN) && d <= addDays(h.toD, windowN)) { windowHit = true; windowName = h.name; break; }
    }
  }

  let next = null;
  for (const h of list) if (h.fromD > d) { if (!next || h.fromD < next.fromD) next = h; }

  return {
    date: ymd(d),
    weekday: WEEK[d.getDay()],
    holiday: !!hit,
    window: windowHit,
    windowDays: windowN,
    name: windowName || '',
    adjustWorkday,
    daysToNext: next ? Math.round((next.fromD - d) / DAY) : null,
    next: next ? ymd(next.fromD) : `${year + 1}-待发布`,
    dataYear: year,
    certainty,
  };
}

/** 只要布尔：该日是否落在「法定节假日及前后各 N 天」（自驾避堵、闭馆核查都用这一个） */
function isWindow(dateStr, windowN = 1) {
  const r = infoFor(dateStr, windowN);
  return r.window;
}

function line(r) {
  return `DATEINFO date=${r.date} weekday=${r.weekday} holiday=${r.holiday ? 'yes' : 'no'} window=${r.window ? 'yes' : 'no'} name=${r.name || '-'} adjustWorkday=${r.adjustWorkday ? 'yes' : 'no'} dataYear=${r.dataYear} certainty=${r.certainty} next=${r.next} daysToNext=${r.daysToNext === null ? '-' : r.daysToNext}`;
}

function listYear(year) {
  const data = load();
  const y = data.years && data.years[String(year)];
  if (!y) return { ok: false };
  return { ok: true, published: !!y.published, source: y.source, holidays: y.holidays || [], workdays: y.workdays || [], fallback: data.fallbackFixedDays || [] };
}

module.exports = { load, ymd, parse, addDays, span, infoFor, isWindow, line, listYear, WEEK, DAY };
