// 日曆：畫出一個月，每天一個圓，上半圓是早上的平均、下半圓是晚上的平均，顏色是分級；
// 沒量的那一半是灰的，下午／其他時段有量就在圓下方加一個小點（概念來自常見血壓計 App）。
// 只產生 HTML，互動由 app.js 處理。

import { dayHalves, localDate } from './stats.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// 一週從哪天開始（0 = 週日）。支援 Intl.Locale 週資訊的瀏覽器依語系決定，否則週日。
function firstDayOfWeek(lang) {
  try {
    const loc = new Intl.Locale(lang);
    const info = loc.getWeekInfo?.() ?? loc.weekInfo;
    if (info?.firstDay) return info.firstDay % 7;
  } catch { /* ignore */ }
  return 0;
}

// 上半圓 / 下半圓 / 小點
export function circleSvg(halves, { small = false } = {}) {
  const half = (h, top) => `<path class="half ${h ? `cat-${h.cat}` : 'empty'}" d="M4,20 A16,16 0 0 ${top ? 1 : 0} 36,20 Z"/>`;
  return `
    <svg class="cal-circle${small ? ' small' : ''}" viewBox="0 0 40 40" aria-hidden="true">
      ${half(halves?.morning, true)}${half(halves?.evening, false)}
      <line class="split" x1="4" y1="20" x2="36" y2="20"/>
      ${halves?.other ? '<circle class="other" cx="20" cy="37.5" r="2.2"/>' : ''}
    </svg>`;
}

// 每天的無障礙說明文字
function dayLabel(t, dayFmt, date, h) {
  const d = dayFmt.format(date);
  if (!h) return d;
  const parts = [];
  if (h.morning) parts.push(`${t('period.morning')} ${h.morning.systolic}/${h.morning.diastolic} ${t(`cat.${h.morning.cat}`)}`);
  if (h.evening) parts.push(`${t('period.evening')} ${h.evening.systolic}/${h.evening.diastolic} ${t(`cat.${h.evening.cat}`)}`);
  if (h.other) parts.push(`${t('period.afternoon')} ${h.other}`);
  return `${d}: ${parts.join(', ')}`;
}

// month：'YYYY-MM'
export function renderCalendar({ records, month, lang, t, selected }) {
  const halves = dayHalves(records);
  const today = localDate(new Date());
  const firstDay = firstDayOfWeek(lang);
  const weekdayFmt = new Intl.DateTimeFormat(lang, { weekday: 'narrow' });
  const dayFmt = new Intl.DateTimeFormat(lang, { month: 'long', day: 'numeric', weekday: 'short' });
  const weekdays = Array.from({ length: 7 }, (_, i) => weekdayFmt.format(new Date(2023, 0, 1 + ((firstDay + i) % 7))));

  const first = new Date(`${month}-01T00:00`);
  const daysInMonth = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  const lead = (first.getDay() - firstDay + 7) % 7;

  const cells = [];
  for (let i = 0; i < lead; i++) cells.push('<span class="cal-blank"></span>');
  for (let d = 1; d <= daysInMonth; d++) {
    const date = new Date(first.getFullYear(), first.getMonth(), d);
    const key = localDate(date);
    const h = halves.get(key);
    const classes = ['cal-day'];
    if (h) classes.push('has-readings');
    if (key === today) classes.push('today');
    if (key === selected) classes.push('selected');
    const future = key > today;
    cells.push(`
      <button type="button" class="${classes.join(' ')}" data-day="${key}" ${future ? 'disabled' : ''}
        aria-label="${esc(dayLabel(t, dayFmt, date, h))}" aria-pressed="${key === selected}">
        <span class="cal-num">${d}</span>
        ${future ? '' : circleSvg(h)}
      </button>`);
  }

  return `
    <div class="cal-grid">
      ${weekdays.map((w) => `<span class="cal-wd">${esc(w)}</span>`).join('')}
      ${cells.join('')}
    </div>`;
}
