// 統計頁：期間篩選 + 兩個子分頁
// - 我的趨勢：平均、達標比例、每日趨勢圖、早晚比較、各級別分布
// - 看診摘要：醫師會看的數據（期間、次數、平均、早晚平均、達標與偏高比例、最高最低），可列印

import { CATEGORIES, PERIODS, classify, onTarget, inRange, dailyAverages, summarize, localDate } from './stats.js';
import { lineChart, tableView, proportionList, attachTooltips, applyProportions } from './charts.js';
import { icon } from './icons.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const STATE_KEY = 'bp.statsState';
const RANGES = { 7: 7, 30: 30, 90: 90, 365: 365, all: null };

function loadState() {
  const def = { tab: 'self', range: '30' };
  try { return { ...def, ...JSON.parse(localStorage.getItem(STATE_KEY) || '{}') }; } catch { return def; }
}

export function createStatsView(root, { t, getLang, getRecords, onAiAnalysis }) {
  let state = loadState();
  const save = () => { try { localStorage.setItem(STATE_KEY, JSON.stringify(state)); } catch { /* ignore */ } };

  const lang = () => getLang();
  const bp = (a) => (a?.systolic == null ? '—' : `${a.systolic}/${a.diastolic}`);
  const pct = (n, total) => (total ? `${Math.round((n / total) * 100)}%` : '—');
  const dateText = (day) => new Date(`${day}T00:00`).toLocaleDateString(lang(), { year: 'numeric', month: 'numeric', day: 'numeric' });
  const shortDay = (day, withYear) => new Date(`${day}T00:00`).toLocaleDateString(lang(), withYear ? { year: '2-digit', month: 'numeric', day: 'numeric' } : { month: 'numeric', day: 'numeric' });
  let chartSpecs = [];
  const chart = (spec) => {
    chartSpecs.push(spec);
    return `<div class="chart-slot" data-chart="${chartSpecs.length - 1}"></div>`;
  };
  const card = (title, body, extra = '') => `<section class="card stat-card ${extra}"><h2>${esc(title)}</h2>${body}</section>`;

  // 期間：最近 N 天（含今天）；全部 = 最早紀錄到今天
  function resolveRange(all) {
    const today = localDate(new Date());
    const days = RANGES[state.range];
    if (days == null) {
      const first = all.reduce((min, r) => (r.time && (!min || r.time < min) ? r.time : min), '');
      return { from: first ? first.slice(0, 10) : today, to: today };
    }
    return { from: localDate(new Date(Date.now() - (days - 1) * 86400000)), to: today };
  }

  function filtersHtml() {
    return `
      <div class="stats-filters">
        <div class="filter-group">
          <span class="filter-label">${esc(t('st.range'))}</span>
          <div class="seg range-seg" role="radiogroup" aria-label="${esc(t('st.range'))}">
            ${Object.keys(RANGES).map((k) => `<button type="button" role="radio" data-range="${k}" aria-checked="${state.range === k}">${esc(t(`st.r${k}`))}</button>`).join('')}
          </div>
        </div>
      </div>
      <div class="stats-tabs-row">
        <div class="seg stats-tabs" role="tablist">
          ${['self', 'doctor'].map((tab) => `<button type="button" role="tab" data-tab="${tab}" aria-selected="${state.tab === tab}" aria-checked="${state.tab === tab}">${esc(t(`st.tab_${tab}`))}</button>`).join('')}
        </div>
        <button type="button" class="ai-chip no-print" data-ai title="${esc(t('ai.desc'))}">${icon('sparkle')}<span>${esc(t('ai.title'))}</span></button>
      </div>`;
  }

  // ---------- 共用片段 ----------

  function trendChart(records, range) {
    const daily = dailyAverages(records);
    if (daily.length < 2) return `<p class="muted small">${esc(t('st.notEnough'))}</p>`;
    const withYear = daily[0].day.slice(0, 4) !== daily[daily.length - 1].day.slice(0, 4);
    const labels = daily.map((d) => shortDay(d.day, withYear));
    const series = [
      { name: t('st.seriesSys'), values: daily.map((d) => d.systolic), cls: 's1' },
      { name: t('st.seriesDia'), values: daily.map((d) => d.diastolic), cls: 's2' },
    ];
    const tip = (i) => `${dateText(daily[i].day)}｜${daily[i].systolic}/${daily[i].diastolic} · ${t('st.colN')} ${daily[i].n}`;
    return chart({ labels, series, refs: [{ value: 130, label: '130', cls: 'r1' }, { value: 80, label: '80', cls: 'r2' }], title: t('st.trendTitle'), tip })
      + tableView(t('st.table'), [t('st.colDay'), t('st.seriesSys'), t('st.seriesDia'), t('st.colN')], daily.map((d) => [dateText(d.day), d.systolic, d.diastolic, d.n]));
  }

  function categoryList(s) {
    const items = CATEGORIES.filter((c) => s.categories[c]).map((c) => ({ label: t(`cat.${c}`), n: s.categories[c], cls: `cat-${c}` }));
    const list = proportionList(items, s.n, (n, total) => `${pct(n, total)}（${t('st.nOf', { n, total })}）`)
      .replace(/<li>\s*<span class="prop-label">([^<]*)<\/span>/g, (m, label) => {
        const it = items.find((x) => esc(x.label) === label);
        return `<li><span class="prop-label"><i class="cat-dot ${it?.cls ?? ''}"></i>${label}</span>`;
      });
    return list + legendHtml();
  }

  function legendHtml() {
    return `
      <details class="table-view">
        <summary>${esc(t('cat.legendTitle'))}</summary>
        <ul class="cat-legend small">
          ${CATEGORIES.map((c) => `<li><i class="cat-dot cat-${c}"></i><strong>${esc(t(`cat.${c}`))}</strong><span class="muted">${esc(t(`catDesc.${c}`))}</span></li>`).join('')}
        </ul>
        <p class="muted small">${esc(t('cat.legendNote'))}</p>
      </details>`;
  }

  function periodTable(s) {
    const rows = PERIODS.filter((p) => s.byPeriod[p].n).map((p) => {
      const a = s.byPeriod[p];
      const cat = classify(a.systolic, a.diastolic);
      return `<tr><th scope="row">${esc(t(`period.${p}`))}</th><td class="num cat-text-${cat}">${bp(a)}</td><td class="num">${a.pulse ?? '—'}</td><td class="num">${a.n}</td></tr>`;
    }).join('');
    if (!rows) return `<p class="muted small">${esc(t('st.notEnough'))}</p>`;
    return `
      <div class="table-wrap"><table>
        <thead><tr><th>${esc(t('st.colPeriod'))}</th><th class="num">${esc(t('st.avg'))}</th><th class="num">${esc(t('st.avgPulse'))}</th><th class="num">${esc(t('st.colN'))}</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>`;
  }

  function deltaHtml(cur, prev) {
    if (cur == null || prev == null) return '';
    const d = cur - prev;
    if (!d) return `<div class="tile-delta">${esc(t('st.same'))}</div>`;
    const good = d < 0; // 血壓下降是好事
    return `<div class="tile-delta ${good ? 'good' : 'bad'}">${good ? '↓' : '↑'} ${esc(t(good ? 'st.deltaDown' : 'st.deltaUp', { v: Math.abs(d) }))}</div>`;
  }

  // ---------- 我的趨勢 ----------

  function selfHtml(records, range, s, prev) {
    const cat = classify(s.avg.systolic, s.avg.diastolic);
    const tile = (label, value, sub = '') => `<div class="tile"><div class="tile-value">${value}</div><div class="tile-label">${esc(label)}</div>${sub}</div>`;
    const days = RANGES[state.range];
    return `
      <div class="tiles">
        ${tile(t('st.avg'), `<span class="cat-text-${cat}">${bp(s.avg)}</span>`, (prev ? deltaHtml(s.avg.systolic, prev.avg.systolic) : '') + `<div class="tile-delta"><span class="cat-badge cat-${cat}">${esc(t(`cat.${cat}`))}</span></div>`)}
        ${tile(t('st.onTarget'), pct(s.onTarget, s.n), `<div class="tile-delta">${esc(t('st.onTargetHint'))}</div>`)}
        ${tile(t('st.avgPulse'), s.avg.pulse ?? '—')}
        ${tile(t('st.days'), `${s.days}<small>/${s.n}</small>`, `<div class="tile-delta">${esc(t('st.readings'))} ${s.n}</div>`)}
      </div>
      ${prev && days ? `<p class="muted small">${esc(t('st.vsPrev', { n: days }))}</p>` : ''}
      ${card(t('st.trendTitle'), trendChart(records, range))}
      <div class="stat-grid">
        ${card(t('st.periodTitle'), periodTable(s))}
        ${card(t('st.categoryTitle'), categoryList(s))}
      </div>`;
  }

  // ---------- 看診摘要 ----------

  function doctorHtml(records, range, s) {
    const kf = (label, value) => `<div class="kf"><dt>${esc(label)}</dt><dd>${value}</dd></div>`;
    const high = records.filter((r) => classify(r.systolic, r.diastolic) === 'stage2' || classify(r.systolic, r.diastolic) === 'crisis').length;
    const reading = (r) => (r ? esc(`${r.systolic}/${r.diastolic}（${dateText(r.time.slice(0, 10))}）`) : `<span class="muted">${esc(t('st.notRecorded'))}</span>`);
    const per = (p) => (s.byPeriod[p].n ? esc(`${bp(s.byPeriod[p])}（${t('st.nOf', { n: s.byPeriod[p].n, total: s.n })}）`) : `<span class="muted">${esc(t('st.notRecorded'))}</span>`);
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
          ${kf(t('st.kfAvg'), `<span class="cat-text-${classify(s.avg.systolic, s.avg.diastolic)}">${bp(s.avg)}</span>`)}
          ${kf(t('st.kfMorning'), per('morning'))}
          ${kf(t('st.kfEvening'), per('evening'))}
          ${kf(t('st.kfOnTarget'), esc(`${pct(s.onTarget, s.n)}（${t('st.nOf', { n: s.onTarget, total: s.n })}）`))}
          ${kf(t('st.kfHigh'), esc(`${pct(high, s.n)}（${t('st.nOf', { n: high, total: s.n })}）`))}
          ${kf(t('st.kfHighest'), reading(s.highest))}
          ${kf(t('st.kfLowest'), reading(s.lowest))}
          ${kf(t('st.kfPulse'), s.avg.pulse != null ? esc(String(s.avg.pulse)) : `<span class="muted">${esc(t('st.notRecorded'))}</span>`)}
        </dl>`)}
      ${card(t('st.trendTitle'), trendChart(records, range))}
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
    // 與前一段相同長度的期間比較（全部時不比較）
    let prev = null;
    const days = RANGES[state.range];
    if (days) {
      const to = localDate(new Date(new Date(`${range.from}T00:00`).getTime() - 86400000));
      const from = localDate(new Date(new Date(`${to}T00:00`).getTime() - (days - 1) * 86400000));
      const p = summarize(inRange(all, from, to));
      if (p.n) prev = p;
    }
    const body = !s.n
      ? `<p class="muted empty-state">${esc(t('st.noData'))}</p>`
      : state.tab === 'doctor' ? doctorHtml(records, range, s) : selfHtml(records, range, s, prev);
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
