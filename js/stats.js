// 血壓統計：全部在瀏覽器內計算，不依賴 DOM。日期以紀錄的本地時間字串為準（YYYY-MM-DD 前綴）。

export function localDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export const dayOf = (iso) => (iso ? iso.slice(0, 10) : null);

// ---------- 分級 ----------
//
// 依 2017 ACC/AHA 與台灣高血壓學會 2022 指引的分級，家庭血壓目標 <130/80。
// 兩個數字落在不同級別時，以較高的級別為準。
// 這只是顏色提示，不是診斷。

export const CATEGORIES = ['low', 'normal', 'elevated', 'stage1', 'stage2', 'crisis'];

// 空字串、null 都當作沒有值（Number('') 會變成 0）
const num = (v) => (v === null || v === undefined || v === '' ? NaN : Number(v));

export function classify(systolic, diastolic) {
  const s = num(systolic);
  const d = num(diastolic);
  if (!Number.isFinite(s) || !Number.isFinite(d)) return null;
  if (s >= 180 || d >= 120) return 'crisis';
  if (s >= 140 || d >= 90) return 'stage2';
  if (s >= 130 || d >= 80) return 'stage1';
  if (s >= 120) return 'elevated';
  if (s < 90 || d < 60) return 'low';
  return 'normal';
}

// 家庭血壓是否達標（<130/80）
export const onTarget = (s, d) => Number.isFinite(s) && Number.isFinite(d) && s < 130 && d < 80;

// ---------- 時段 ----------
//
// 早上：04:00–11:59；下午：12:00–17:59；晚上：18:00–03:59。
// 指引建議早晚各量，所以統計只分早／晚（下午歸入「其他」）。

export const PERIODS = ['morning', 'afternoon', 'evening'];

export function periodOf(iso) {
  if (typeof iso !== 'string' || iso.length < 16) return null;
  const h = Number(iso.slice(11, 13));
  if (!Number.isFinite(h)) return null;
  if (h >= 4 && h < 12) return 'morning';
  if (h >= 12 && h < 18) return 'afternoon';
  return 'evening';
}

// ---------- 平均 ----------

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const round = (v) => (v == null ? null : Math.round(v));

// 一組紀錄的平均（四捨五入到整數）；心跳只算有填的
export function average(records) {
  const valid = records.filter((r) => Number.isFinite(r.systolic) && Number.isFinite(r.diastolic));
  const pulses = records.map((r) => r.pulse).filter((p) => Number.isFinite(p));
  return {
    n: valid.length,
    systolic: round(mean(valid.map((r) => r.systolic))),
    diastolic: round(mean(valid.map((r) => r.diastolic))),
    pulse: round(mean(pulses)),
    pulseN: pulses.length,
  };
}

// 依日期分組（由舊到新）
export function groupByDay(records) {
  const map = new Map();
  for (const r of records) {
    const day = dayOf(r.time);
    if (!day) continue;
    if (!map.has(day)) map.set(day, []);
    map.get(day).push(r);
  }
  return new Map([...map.entries()].sort((a, b) => a[0].localeCompare(b[0])));
}

// 每日平均：[{ day, systolic, diastolic, pulse, n }]，給趨勢圖用
export function dailyAverages(records) {
  return [...groupByDay(records).entries()].map(([day, list]) => ({ day, ...average(list) }));
}

// ---------- 區間摘要 ----------

// 取 from–to（含）之間的紀錄
export function inRange(records, from, to) {
  return records.filter((r) => {
    const d = dayOf(r.time);
    return d && d >= from && d <= to;
  });
}

// 給統計頁與看診摘要：筆數、天數、平均、早晚平均、各級別筆數、達標比例、最高值
export function summarize(records) {
  const valid = records.filter((r) => Number.isFinite(r.systolic) && Number.isFinite(r.diastolic));
  const byPeriod = Object.fromEntries(PERIODS.map((p) => [p, average(valid.filter((r) => periodOf(r.time) === p))]));
  const categories = Object.fromEntries(CATEGORIES.map((c) => [c, 0]));
  for (const r of valid) categories[classify(r.systolic, r.diastolic)] += 1;
  const onTargetN = valid.filter((r) => onTarget(r.systolic, r.diastolic)).length;
  const highest = valid.reduce((max, r) => (!max || r.systolic > max.systolic || (r.systolic === max.systolic && r.diastolic > max.diastolic) ? r : max), null);
  const lowest = valid.reduce((min, r) => (!min || r.systolic < min.systolic || (r.systolic === min.systolic && r.diastolic < min.diastolic) ? r : min), null);
  return {
    n: valid.length,
    days: groupByDay(valid).size,
    avg: average(valid),
    byPeriod,
    categories,
    onTarget: onTargetN,
    highest,
    lowest,
  };
}

// 「722」習慣：最近 7 天裡，早晚都有量的天數
export function sevenTwoTwo(records, today) {
  const end = new Date(`${today}T00:00`);
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(end);
    d.setDate(end.getDate() - i);
    return localDate(d);
  });
  const byDay = groupByDay(records);
  let both = 0;
  let any = 0;
  for (const day of days) {
    const list = byDay.get(day) ?? [];
    if (!list.length) continue;
    any += 1;
    const periods = new Set(list.map((r) => periodOf(r.time)));
    if (periods.has('morning') && periods.has('evening')) both += 1;
  }
  return { days: 7, any, both };
}

// ---------- 日曆 ----------

// 每一天的早／晚平均（給日曆的上下半圓用）與其他時段的筆數。
// Map(day → { morning: { systolic, diastolic, n, cat } | null, evening: ..., other: n })
export function dayHalves(records) {
  const map = new Map();
  for (const [day, list] of groupByDay(records)) {
    const half = (p) => {
      const a = average(list.filter((r) => periodOf(r.time) === p));
      return a.n ? { systolic: a.systolic, diastolic: a.diastolic, n: a.n, cat: classify(a.systolic, a.diastolic) } : null;
    };
    map.set(day, { morning: half('morning'), evening: half('evening'), other: list.filter((r) => periodOf(r.time) === 'afternoon').length });
  }
  return map;
}
