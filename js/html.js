// 產生 HTML 字串時共用的小工具

// 文字放進 HTML 前跳脫
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// 分級色點（顏色由 .cat-<級別> 的 --cat 決定）
export const catDot = (cat) => `<i class="cat-dot cat-${cat}"></i>`;

// 膠囊選項（radio / checkbox）
export const chipHtml = (type, name, value, label, checked = false) =>
  `<label class="chip"><input type="${type}" name="${name}" value="${value}"${checked ? ' checked' : ''}><span>${esc(label)}</span></label>`;
