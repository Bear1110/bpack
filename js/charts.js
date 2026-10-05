// 輕量圖表（inline SVG），不載入外部套件。
//
// 規格（依資料視覺化指引）：
// - 格線、軸線為 1px 實線，顏色低調；參考線同樣是 1px 實線並直接標註
// - 兩個以上系列一定有圖例；單一系列不放圖例（標題已說明）
// - 每個資料點都可 hover / 鍵盤聚焦，顯示數值提示；並附「表格」檢視，數值不必靠 hover 才看得到
// - 文字一律用文字色，不用資料色

import { esc } from './html.js';

// 漂亮的 Y 軸範圍：不從 0 開始（血壓集中在 60–180），上下留一格
function niceRange(min, max) {
  const span = Math.max(10, max - min);
  const raw = span / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  const lo = Math.floor(min / step) * step - step;
  const hi = Math.ceil(max / step) * step + step;
  const ticks = [];
  for (let v = lo; v <= hi + step * 0.001; v += step) ticks.push(Math.round(v * 1000) / 1000);
  return { lo, hi, ticks };
}

/**
 * 折線圖（一或多系列，值為 null 時斷線）
 * @param {object} o
 * @param {string[]} o.labels
 * @param {{name:string, values:(number|null)[], cls:string}[]} o.series
 * @param {number} o.width
 * @param {number} [o.height]
 * @param {{value:number, label:string, cls?:string}[]} [o.refs]  參考線（例如 130 / 80）
 * @param {(i:number)=>boolean} [o.showLabel]
 * @param {(v:number)=>string} [o.fmt]
 * @param {(i:number)=>string} [o.tip]   每個 X 位置的提示文字（預設列出各系列的值）
 * @param {string} o.title
 */
export function lineChart({ labels, series, width, height = 220, refs = [], showLabel, fmt = String, tip, title }) {
  const pad = { top: 16, right: 12, bottom: 26, left: 34 };
  const W = Math.max(240, width);
  const H = height;
  const plotW = W - pad.left - pad.right;
  const plotH = H - pad.top - pad.bottom;
  const all = [...series.flatMap((s) => s.values.filter((v) => v != null)), ...refs.map((r) => r.value)];
  const { lo, hi, ticks } = niceRange(Math.min(...all), Math.max(...all));
  const y = (v) => pad.top + plotH - ((v - lo) / (hi - lo)) * plotH;
  const n = labels.length;
  const x = (i) => pad.left + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const stepN = Math.ceil(n / 8);
  const every = showLabel ?? ((i) => n <= 8 || i === n - 1 || (i % stepN === 0 && n - 1 - i >= stepN / 2));

  const grid = ticks.map((tv) => `
    <line class="grid" x1="${pad.left}" x2="${W - pad.right}" y1="${y(tv)}" y2="${y(tv)}"/>
    <text class="tick" x="${pad.left - 6}" y="${y(tv) + 4}" text-anchor="end">${esc(fmt(tv))}</text>`).join('');

  const paths = series.map((s) => {
    let d = '';
    let pen = false;
    s.values.forEach((v, i) => {
      if (v == null) { pen = false; return; }
      d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    });
    const dots = s.values.map((v, i) => (v == null ? '' : `<circle class="dot" cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="${n > 40 ? 2 : 3.5}"/>`)).join('');
    return `<g class="line ${s.cls}"><path d="${d}"/>${dots}</g>`;
  }).join('');

  // 熱區：每個 X 位置一條直欄，hover / 聚焦時顯示該日的所有值
  const band = n > 1 ? plotW / (n - 1) : plotW;
  const hits = labels.map((label, i) => {
    const text = tip ? tip(i) : `${label}｜${series.map((s) => `${s.name} ${s.values[i] == null ? '—' : fmt(s.values[i])}`).join('、')}`;
    return `<rect class="hit" tabindex="0" data-tip="${esc(text)}" aria-label="${esc(text)}" x="${(x(i) - band / 2).toFixed(1)}" y="${pad.top}" width="${band.toFixed(1)}" height="${plotH}"/>`;
  }).join('');

  const xLabels = labels.map((label, i) => (every(i) ? `
    <text class="tick" x="${x(i).toFixed(1)}" y="${H - 8}" text-anchor="${i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}">${esc(label)}</text>` : '')).join('');

  const refLines = refs.map((r) => `
    <line class="ref ${r.cls ?? ''}" x1="${pad.left}" x2="${W - pad.right}" y1="${y(r.value)}" y2="${y(r.value)}"/>
    <text class="ref-label" x="${W - pad.right}" y="${y(r.value) - 4}" text-anchor="end">${esc(r.label)}</text>`).join('');

  const legend = series.length > 1 ? `
    <div class="legend">${series.map((s) => `<span><i class="key ${s.cls}"></i>${esc(s.name)}</span>`).join('')}</div>` : '';

  return `
    ${legend}
    <svg class="chart" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(title)}">
      ${grid}
      <line class="axis" x1="${pad.left}" x2="${W - pad.right}" y1="${pad.top + plotH}" y2="${pad.top + plotH}"/>
      ${refLines}
      ${paths}
      ${hits}
      ${xLabels}
    </svg>`;
}

/**
 * 表格檢視（收在 <details> 裡）
 * @param {string} summary
 * @param {string[]} head
 * @param {(string|number)[][]} rows
 */
export function tableView(summary, head, rows) {
  return `
    <details class="table-view">
      <summary>${esc(summary)}</summary>
      <div class="table-wrap"><table>
        <thead><tr>${head.map((h, i) => `<th${i ? ' class="num"' : ''}>${esc(h)}</th>`).join('')}</tr></thead>
        <tbody>${rows.map((r) => `<tr>${r.map((c, i) => (i ? `<td class="num">${esc(c)}</td>` : `<th scope="row">${esc(c)}</th>`)).join('')}</tr>`).join('')}</tbody>
      </table></div>
    </details>`;
}

/**
 * 比例清單（橫條）：「正常 45%（9/20）」
 * @param {{label:string, n:number, prefix?:string}[]} items  prefix：放在標籤前的 HTML（例如色點）
 * @param {number} total  分母
 * @param {(n:number,total:number)=>string} fmt
 */
export function proportionList(items, total, fmt) {
  if (!items.length) return '';
  return `<ul class="prop-list">${items.map(({ label, n, prefix = '' }) => {
    const pct = total ? (n / total) * 100 : 0;
    return `
      <li>
        <span class="prop-label">${prefix}${esc(label)}</span>
        <span class="prop-track"><span class="prop-fill" data-pct="${pct.toFixed(1)}"></span></span>
        <span class="prop-value">${esc(fmt(n, total))}</span>
      </li>`;
  }).join('')}</ul>`;
}

// 比例橫條的寬度：CSP 不允許 HTML 內的 style 屬性，改由 JS 設定（CSSOM 不受限制）
export function applyProportions(root) {
  root.querySelectorAll('.prop-fill[data-pct]').forEach((el) => { el.style.width = `${el.dataset.pct}%`; });
}

// ---------- 提示框（全頁共用一個） ----------

let tooltip;
function ensureTooltip() {
  if (tooltip) return tooltip;
  tooltip = document.createElement('div');
  tooltip.className = 'chart-tip';
  tooltip.setAttribute('role', 'tooltip');
  tooltip.hidden = true;
  document.body.append(tooltip);
  return tooltip;
}

function show(target, x, y) {
  const tip = ensureTooltip();
  tip.textContent = target.dataset.tip;
  tip.hidden = false;
  const r = tip.getBoundingClientRect();
  const left = Math.min(window.innerWidth - r.width - 8, Math.max(8, x - r.width / 2));
  const top = y - r.height - 12 < 8 ? y + 16 : y - r.height - 12;
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
  target.classList.add('active');
}

function hide(target) {
  if (tooltip) tooltip.hidden = true;
  target?.classList.remove('active');
}

// 在容器上掛一次即可：滑鼠、觸控、鍵盤聚焦都會顯示提示
export function attachTooltips(root) {
  let current = null;
  root.addEventListener('pointermove', (e) => {
    const bar = e.target.closest('[data-tip]');
    if (bar !== current) hide(current);
    current = bar;
    if (bar) show(bar, e.clientX, e.clientY);
  });
  root.addEventListener('pointerleave', () => { hide(current); current = null; });
  root.addEventListener('focusin', (e) => {
    const bar = e.target.closest('[data-tip]');
    if (!bar) return;
    const r = bar.getBoundingClientRect();
    show(bar, r.left + r.width / 2, r.top);
    current = bar;
  });
  root.addEventListener('focusout', () => { hide(current); current = null; });
  window.addEventListener('scroll', () => hide(current), { passive: true });
}
