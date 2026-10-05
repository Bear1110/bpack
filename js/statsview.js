// 統計頁：期間篩選 + 兩個子分頁
// - 我的趨勢：平均、達標比例、每日趨勢圖、早晚比較、各級別分布、吃藥前後
// - 看診摘要：醫師會看的數據（期間、次數、平均、早晚平均、達標與偏高比例、最高最低、吃藥前後），可列印

import { CATEGORIES, PERIODS, classify, inRange, dailyAverages, summarize, splitByMeds, localDate, parseDay, addDays, bpText } from './stats.js';
import { lineChart, tableView, proportionList, attachTooltips, applyProportions } from './charts.js';
import { readJson, writeJson } from './store.js';
import { esc, catDot } from './html.js';
import { icon } from './icons.js';

const STATE_KEY = 'bp.statsState';
const RANGES = ['7', '30', '90', '365', 'all'];

export function createStatsView(root, { t, getLang, getRecords, onAiAnalysis }) {
  const state = { tab: 'self', range: '30', ...readJson(STATE_KEY, {}) };
  const save = () => writeJson(STATE_KEY, state);
  const rangeDays = () => Number(state.range) || null; // 'all' → null

  const bp = (a) => bpText(a?.systolic, a?.diastolic);
  const pct = (n, total) => (total ? `${Math.round((n / total) * 100)}%` : '—');
  const nOf = (n, total) => `${pct(n, total)}（${t('st.nOf', { n, total })}）`;
  const dateText = (day) => parseDay(day).toLocaleDateString(getLang(), { year: 'numeric', month: 'numeric', day: 'numeric' });
  const shortDay = (day, withYear) => parseDay(day).toLocaleDateString(getLang(), withYear ? { year: '2-digit', month: 'numeric', day: 'numeric' } : { month: 'numeric', day: 'numeric' });
  const na = () => `<span class="muted">${esc(t('st.notRecorded'))}</span>`;
  // 「128/82（26/52）」；沒有紀錄時顯示「未記錄」
  const avgOf = (a, total) => (a.n ? esc(`${bp(a)}（${t('st.nOf', { n: a.n, total })}）`) : na());
  const catText = (a) => `cat-text cat-${classify(a.systolic, a.diastolic)}`;
  let chartSpecs = [];
  const chart = (spec) => {
    chartSpecs.push(spec);
    return `<div class="chart-slot" data-chart="${chartSpecs.length - 1}"></div>`;
  };
  const card = (title, body) => `<section class="card stat-card"><h2>${esc(title)}</h2>${body}</section>`;
  const notEnough = () => `<p class="muted small">${esc(t('st.notEnough'))}</p>`;

  // 期間：最近 N 天（含今天）；全部 = 最早紀錄到今天
  function resolveRange(all) {
    const today = localDate(new Date());
    const days = rangeDays();
    if (!days) {
      const first = all.reduce((min, r) => (r.time && (!min || r.time < min) ? r.time : min), '');
      return { from: first ? first.slice(0, 10) : today, to: today };
    }
    return { from: addDays(today, -(days - 1)), to: today };
  }

  function filtersHtml() {
    return `
      <div class="stats-filters">
        <div class="filter-group">
          <span class="filter-label">${esc(t('st.range'))}</span>
          <div class="seg range-seg" role="radiogroup" aria-label="${esc(t('st.range'))}">
            ${RANGES.map((k) => `<button type="button" role="radio" data-range="${k}" aria-checked="${state.range === k}">${esc(t(`st.r${k}`))}</button>`).join('')}
          </div>
        </div>
      </div>
      <div class="stats-tabs-row">
        <div class="seg stats-tabs" role="tablist">
          ${['self', 'doctor'].map((tab) => `<button type="button" role="tab" data-tab="${tab}" aria-selected="${state.tab === tab}">${esc(t(`st.tab_${tab}`))}</button>`).join('')}
        </div>
        <button type="button" class="ai-chip no-print" data-ai title="${esc(t('ai.desc'))}">${icon('sparkle')}<span>${esc(t('ai.title'))}</span></button>
      </div>`;
  }

  // ---------- 共用片段 ----------

  function trendChart(records) {
    const daily = dailyAverages(records);
    if (daily.length < 2) return notEnough();
    const withYear = daily[0].day.slice(0, 4) !== daily[daily.length - 1].day.slice(0, 4);
    const labels = daily.map((d) => shortDay(d.day, withYear));
    const series = [
      { name: t('st.seriesSys'), values: daily.map((d) => d.systolic), cls: 's1' },
      { name: t('st.seriesDia'), values: daily.map((d) => d.diastolic), cls: 's2' },
    ];
    const tip = (i) => `${dateText(daily[i].day)}｜${bpText(daily[i].systolic, daily[i].diastolic)} · ${t('st.colN')} ${daily[i].n}`;
    return chart({ labels, series, refs: [{ value: 130, label: '130', cls: 'r1' }, { value: 80, label: '80', cls: 'r2' }], title: t('st.trendTitle'), tip })
      + tableView(t('st.table'), [t('st.colDay'), t('st.seriesSys'), t('st.seriesDia'), t('st.colN')], daily.map((d) => [dateText(d.day), d.systolic, d.diastolic, d.n]));
  }

  function categoryList(s) {
    const items = CATEGORIES.filter((c) => s.categories[c]).map((c) => ({ label: t(`cat.${c}`), n: s.categories[c], prefix: catDot(c) }));
    return proportionList(items, s.n, nOf) + `
      <details class="table-view">
        <summary>${esc(t('cat.legendTitle'))}</summary>
        <ul class="cat-legend small">
          ${CATEGORIES.map((c) => `<li>${catDot(c)}<strong>${esc(t(`cat.${c}`))}</strong><span class="muted">${esc(t(`catDesc.${c}`))}</span></li>`).join('')}
        </ul>
        <p class="muted small">${esc(t('cat.legendNote'))}</p>
      </details>`;
  }

  // 平均表：第一欄標籤、平均血壓（分級色）、平均心跳、次數
  const avgRow = (label, a) => (a.n ? `<tr><th scope="row">${esc(label)}</th><td class="num ${catText(a)}">${bp(a)}</td><td class="num">${a.pulse ?? '—'}</td><td class="num">${a.n}</td></tr>` : '');
  const avgTable = (firstHeader, rows) => `
    <div class="table-wrap"><table>
      <thead><tr><th>${esc(firstHeader)}</th><th class="num">${esc(t('st.avg'))}</th><th class="num">${esc(t('st.avgPulse'))}</th><th class="num">${esc(t('st.colN'))}</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;

  function periodTable(s) {
    const rows = PERIODS.map((p) => avgRow(t(`period.${p}`), s.byPeriod[p])).join('');
    return rows ? avgTable(t('st.colPeriod'), rows) : notEnough();
  }

  // 吃藥前 / 吃藥後（只有有標記時才顯示）
  function medsCard(meds) {
    if (!meds.any) return '';
    const rows = avgRow(t('opt.tags.before_meds'), meds.before) + avgRow(t('opt.tags.after_meds'), meds.after);
    return card(t('st.medsTitle'), `${avgTable(t('st.colMeds'), rows)}<p class="muted small">${esc(t('st.medsNote'))}</p>`);
  }

  function deltaHtml(cur, prev) {
    if (cur == null || prev == null) return '';
    const d = cur - prev;
    if (!d) return `<div class="tile-delta">${esc(t('st.same'))}</div>`;
    const good = d < 0; // 血壓下降是好事
    return `<div class="tile-delta ${good ? 'good' : 'bad'}">${good ? '↓' : '↑'} ${esc(t(good ? 'st.deltaDown' : 'st.deltaUp', { v: Math.abs(d) }))}</div>`;
  }

  // ---------- 我的趨勢 ----------

  function selfHtml(records, s, prev, meds) {
    const cat = classify(s.avg.systolic, s.avg.diastolic);
    const tile = (label, value, sub = '') => `<div class="tile"><div class="tile-value">${value}</div><div class="tile-label">${esc(label)}</div>${sub}</div>`;
    const days = rangeDays();
    return `
      <div class="tiles">
        ${tile(t('st.avg'), `<span class="${catText(s.avg)}">${bp(s.avg)}</span>`, (prev ? deltaHtml(s.avg.systolic, prev.avg.systolic) : '') + `<div class="tile-delta"><span class="cat-badge cat-${cat}">${esc(t(`cat.${cat}`))}</span></div>`)}
        ${tile(t('st.onTarget'), pct(s.onTarget, s.n), `<div class="tile-delta">${esc(t('st.onTargetHint'))}</div>`)}
        ${tile(t('st.avgPulse'), s.avg.pulse ?? '—')}
        ${tile(t('st.days'), `${s.days}<small>/${s.n}</small>`, `<div class="tile-delta">${esc(t('st.readings'))} ${s.n}</div>`)}
      </div>
      ${prev && days ? `<p class="muted small">${esc(t('st.vsPrev', { n: days }))}</p>` : ''}
      ${card(t('st.trendTitle'), trendChart(records))}
      <div class="stat-grid">
        ${card(t('st.periodTitle'), periodTable(s))}
        ${card(t('st.categoryTitle'), categoryList(s))}
      </div>
      ${medsCard(meds)}`;
  }

  // ---------- 看診摘要 ----------

  function doctorHtml(records, range, s, meds) {
    const kf = (label, value) => `<div class="kf"><dt>${esc(label)}</dt><dd>${value}</dd></div>`;
    const high = s.categories.stage2 + s.categories.crisis;
    const reading = (r) => (r ? esc(`${bpText(r.systolic, r.diastolic)}（${dateText(r.time.slice(0, 10))}）`) : na());
    return `
      <header class="report-head">
        <div>
          <h2>${esc(t('st.reportTitle'))}</h2>
          <p class="muted small">${esc(t('st.generated', { d: dateText(localDate(new Date())) }))}</p>
        </div>
        <button type="button" class="btn ghost small no-print btn-with-icon" data-print>${icon('print')}${esc(t('st.print'))}</button>
      </header>
      ${card(t('st.keyFigures'), `
        <dl class="key-figures">
          ${kf(t('st.kfPeriod'), esc(t('st.kfPeriodVal', { from: dateText(range.from), to: dateText(range.to), n: s.days })))}
          ${kf(t('st.kfReadings'), esc(String(s.n)))}
          ${kf(t('st.kfAvg'), `<span class="${catText(s.avg)}">${bp(s.avg)}</span>`)}
          ${kf(t('st.kfMorning'), avgOf(s.byPeriod.morning, s.n))}
          ${kf(t('st.kfEvening'), avgOf(s.byPeriod.evening, s.n))}
          ${kf(t('st.kfOnTarget'), esc(nOf(s.onTarget, s.n)))}
          ${kf(t('st.kfHigh'), esc(nOf(high, s.n)))}
          ${kf(t('st.kfHighest'), reading(s.highest))}
          ${kf(t('st.kfLowest'), reading(s.lowest))}
          ${kf(t('st.kfPulse'), s.avg.pulse != null ? esc(String(s.avg.pulse)) : na())}
          ${meds.any ? kf(t('st.kfBefore'), avgOf(meds.before, s.n)) + kf(t('st.kfAfter'), avgOf(meds.after, s.n)) : ''}
        </dl>`)}
      ${card(t('st.trendTitle'), trendChart(records))}
      ${card(t('st.categoryTitle'), categoryList(s))}
      <p class="muted small report-foot">${esc(t('st.reportFooter'))}</p>`;
  }

  // ---------- 主要繪製 ----------

  function render() {
    chartSpecs = [];
    const all = getRecords();
    const range = resolveRange(all);
    const records = inRange(all, range.from, range.to);
    const s = summarize(records);
    const meds = splitByMeds(records);
    // 與前一段相同長度的期間比較（全部時不比較）
    let prev = null;
    const days = rangeDays();
    if (days) {
      const to = addDays(range.from, -1);
      const p = summarize(inRange(all, addDays(to, -(days - 1)), to));
      if (p.n) prev = p;
    }
    const body = !s.n
      ? `<p class="muted empty-state">${esc(t('st.noData'))}</p>`
      : state.tab === 'doctor' ? doctorHtml(records, range, s, meds) : selfHtml(records, s, prev, meds);
    root.innerHTML = `${filtersHtml()}<div class="stats-body" data-tab="${state.tab}">${body}</div>`;
    drawCharts();
    applyProportions(root);
  }

  function drawCharts() {
    root.querySelectorAll('.chart-slot').forEach((slot) => {
      const spec = chartSpecs[Number(slot.dataset.chart)];
      if (spec && slot.clientWidth) slot.innerHTML = lineChart({ ...spec, width: slot.clientWidth });
    });
  }

  root.addEventListener('click', (e) => {
    if (e.target.closest('[data-ai]')) return onAiAnalysis?.();
    const el = e.target.closest('[data-range],[data-tab],[data-print]');
    if (!el) return;
    if (el.dataset.print !== undefined) return window.print();
    if (el.dataset.range) state.range = el.dataset.range;
    if (el.dataset.tab) state.tab = el.dataset.tab;
    save();
    render();
  });
  attachTooltips(root);

  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (root.offsetParent) drawCharts(); }, 150);
  });

  return { render };
}
