import * as auth from './auth.js';
import * as store from './store.js';
import { openSpreadsheet, fetchEmail, ApiError } from './sheets.js';
import { OPTIONS, LIMITS, NUMERIC_FIELDS, newId } from './schema.js';
import { CLIENT_ID } from './config.js';
import { t, getLang, setLang, initI18n, LANGS } from './i18n.js';
import { localDate, dayOf, classify, periodOf, average, groupByDay, inRange, sevenTwoTwo, CATEGORIES } from './stats.js';
import { createStatsView } from './statsview.js';
import { renderCalendar as calendarHtml, circleSvg } from './calendar.js';
import { buildPrompt, aiLinks, parseImport, buildExport } from './importer.js';
import { applyIcons, icon } from './icons.js';
import { APP_VERSION } from './version.js';

const $ = (sel) => document.querySelector(sel);
const pad = (n) => String(n).padStart(2, '0');

let sheet = null;
let syncState = 'idle'; // idle | syncing | error | offline
let authReady = false;
let editing = null; // 對話框正在編輯的紀錄

function nowLocal() {
  const d = new Date();
  return `${localDate(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// 「128/82」這種寫法各語言相同
const bpText = (s, d) => `${s}/${d}`;

function formatDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const year = d.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {};
  return d.toLocaleString(getLang(), { ...year, month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit' });
}

function formatDay(day) {
  const d = new Date(`${day}T00:00`);
  const year = d.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {};
  return d.toLocaleDateString(getLang(), { ...year, month: 'numeric', day: 'numeric', weekday: 'short' });
}

const formatTime = (iso) => new Date(iso).toLocaleTimeString(getLang(), { hour: '2-digit', minute: '2-digit' });

let toastTimer;
// action：{ label, run }，例如「復原」；有按鈕時停留久一點
function toast(msg, ms = 3000, action = null) {
  const el = $('#toast');
  el.innerHTML = `<span>${escapeHtml(msg)}</span>${action ? `<button type="button" class="toast-action">${icon(action.icon ?? 'undo')}${escapeHtml(action.label)}</button>` : ''}`;
  el.hidden = false;
  if (action) {
    el.querySelector('.toast-action').addEventListener('click', () => {
      el.hidden = true;
      action.run();
    }, { once: true });
  }
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, action ? Math.max(ms, 6000) : ms);
}

// 手機上的觸覺回饋（支援的瀏覽器才會震動；iOS 網頁不支援，安靜略過）
const buzz = (ms = 20) => { try { navigator.vibrate?.(ms); } catch { /* ignore */ } };

// ---------- 同步 ----------

async function trySync() {
  const token = auth.getToken();
  if (!token) return render();
  if (!navigator.onLine) {
    syncState = 'offline';
    return render();
  }
  syncState = 'syncing';
  renderSync();
  try {
    if (!sheet) {
      sheet = await openSpreadsheet(token, { cachedId: store.getCachedSheetId(), title: t('app.sheetTitle') });
      store.setCachedSheetId(sheet.id);
    }
    const { conflicts } = await store.sync(sheet, token);
    syncState = 'idle';
    if (conflicts) toast(t('sync.conflicts', { n: conflicts }), 6000);
  } catch (e) {
    console.error(e);
    if (e instanceof ApiError && e.status === 401) {
      auth.invalidateToken(); // 權杖失效：等使用者按「重新連線」
      syncState = 'idle';
    } else {
      syncState = navigator.onLine ? 'error' : 'offline';
    }
  }
  render();
}

// 必須在點擊事件中同步呼叫（見 auth.requestToken）
function signIn() {
  auth.requestToken({ firstTime: !auth.getEmail() })
    .then(async (token) => {
      try {
        const email = await fetchEmail(token);
        const prev = auth.getEmail();
        if (prev && prev !== email) {
          // 換了帳號：改用新帳號的試算表
          sheet = null;
          store.setCachedSheetId(null);
        }
        auth.setEmail(email);
      } catch (e) {
        console.warn('userinfo failed', e);
      }
      await trySync();
    })
    .catch((e) => {
      if (e.message === 'superseded') return;
      toast(e.message === 'popup_failed_to_open' ? t('error.popup') : t('error.auth'));
    });
}

function signOut() {
  auth.signOut();
  store.clearLocal();
  sheet = null;
  render();
}

// ---------- 紀錄操作 ----------

function save(record, isNew) {
  const now = new Date().toISOString();
  record.updated_at = now;
  if (isNew) record.created_at = now;
  store.saveRecord(record, { isNew });
  trySync();
}

// 刪除後可復原：把整筆紀錄當新紀錄加回去
function deleteWithUndo(record) {
  store.deleteRecord(record.id);
  trySync();
  toast(t('undo.deleted'), 6000, {
    label: t('undo.undo'),
    run: () => {
      store.saveRecord({ ...record, updated_at: new Date().toISOString() }, { isNew: true });
      trySync();
    },
  });
}

function emptyRecord() {
  return { id: newId(), time: nowLocal(), systolic: null, diastolic: null, pulse: null, arm: '', tags: [], notes: '' };
}

// ---------- 表單（首頁與編輯對話框共用同一組欄位） ----------

// withTime：編輯對話框一律顯示時間欄；首頁改用「現在／改時間」
function fieldsHtml(withTime) {
  const num = (name, hint, unit, placeholder, big = true) => `
    <label class="bp-field ${big ? 'big' : 'pulse'}">
      <span class="bp-label">${escapeHtml(t(`log.${name}`))} <small>${escapeHtml(t(`log.${hint}`))}</small></span>
      <span class="bp-input">
        <input type="number" inputmode="numeric" name="${name}" min="${LIMITS[name][0]}" max="${LIMITS[name][1]}" step="1" placeholder="${placeholder}" autocomplete="off">
        <span class="bp-unit">${escapeHtml(t(unit))}</span>
      </span>
    </label>`;
  const chips = (field, type) => OPTIONS[field].map((c) => `<label class="chip"><input type="${type}" name="${field}" value="${c}"><span>${escapeHtml(t(`opt.${field}.${c}`))}</span></label>`).join('');
  return `
    <div class="bp-inputs">
      ${num('systolic', 'systolicHint', 'log.unit', '120')}
      <span class="bp-slash" aria-hidden="true">/</span>
      ${num('diastolic', 'diastolicHint', 'log.unit', '80')}
      ${num('pulse', 'pulseHint', 'log.pulseUnit', '70', false)}
    </div>
    ${withTime
      ? `<label class="field"><span>${escapeHtml(t('log.time'))}</span><input type="datetime-local" name="time" required></label>`
      : `<div class="log-time">
          ${icon('clock')}<span class="log-time-text" data-time-text></span>
          <button type="button" class="link-btn" data-toggle-time>${escapeHtml(t('log.changeTime'))}</button>
          <input type="datetime-local" name="time" class="log-time-input" hidden aria-label="${escapeHtml(t('log.time'))}">
        </div>`}
    <details class="log-more">
      <summary>${escapeHtml(t('log.more'))}</summary>
      <fieldset class="field"><legend>${escapeHtml(t('log.arm'))}</legend><div class="chips">${chips('arm', 'radio')}</div></fieldset>
      <fieldset class="field"><legend>${escapeHtml(t('log.tags'))}</legend><div class="chips">${chips('tags', 'checkbox')}</div></fieldset>
      <label class="field"><span>${escapeHtml(t('log.notes'))}</span><textarea name="notes" rows="2"></textarea></label>
    </details>`;
}

function buildForms() {
  $('#log-fields').innerHTML = fieldsHtml(false);
  $('#form-fields').innerHTML = fieldsHtml(true);
  logTimeMode = 'now';
  renderLogTime();
}

// 首頁的時間：預設「現在」（存檔那一刻），按「改時間」才出現選擇器（補登用）
let logTimeMode = 'now'; // now | custom
function renderLogTime() {
  const form = $('#log-form');
  const text = form.querySelector('[data-time-text]');
  const input = form.elements.time;
  const btn = form.querySelector('[data-toggle-time]');
  if (!text) return;
  if (logTimeMode === 'now') {
    text.textContent = `${t('log.now')} · ${formatDateTime(nowLocal())}`;
    text.hidden = false;
    input.hidden = true;
    btn.textContent = t('log.changeTime');
  } else {
    text.hidden = true;
    input.hidden = false;
    if (!input.value) input.value = nowLocal();
    input.max = nowLocal();
    btn.textContent = t('log.useNow');
  }
}

function toggleLogTime() {
  logTimeMode = logTimeMode === 'now' ? 'custom' : 'now';
  renderLogTime();
  if (logTimeMode === 'custom') $('#log-form').elements.time.focus();
}

// 讀取表單 → 紀錄；回傳 { record } 或 { error }
function readForm(form, base) {
  const f = form.elements;
  const nums = {};
  for (const name of NUMERIC_FIELDS) {
    const raw = f[name].value.trim();
    if (!raw) {
      nums[name] = null;
      continue;
    }
    const v = Number(raw);
    const [min, max] = LIMITS[name];
    if (!Number.isInteger(v) || v < min || v > max) return { error: t('log.range', { field: t(`log.${name}`), min, max }) };
    nums[name] = v;
  }
  if (nums.systolic == null || nums.diastolic == null) return { error: t('log.required') };
  if (nums.systolic <= nums.diastolic) return { error: t('log.invalid') };
  const time = f.time.hidden || !f.time.value ? nowLocal() : f.time.value;
  const record = {
    ...base,
    time,
    ...nums,
    arm: form.querySelector('input[name="arm"]:checked')?.value ?? '',
    tags: [...form.querySelectorAll('input[name="tags"]:checked')].map((el) => el.value),
    notes: f.notes.value.trim(),
  };
  return { record };
}

function fillForm(form, r) {
  const f = form.elements;
  for (const name of NUMERIC_FIELDS) f[name].value = r[name] ?? '';
  if (f.time) f.time.value = r.time || '';
  form.querySelectorAll('input[name="arm"]').forEach((el) => { el.checked = el.value === r.arm; });
  form.querySelectorAll('input[name="tags"]').forEach((el) => { el.checked = r.tags?.includes(el.value); });
  f.notes.value = r.notes || '';
  form.querySelector('.log-more').open = !!(r.arm || r.tags?.length || r.notes);
}

function showError(el, msg) {
  el.textContent = msg;
  el.hidden = !msg;
}

// 首頁存檔：成功後清空數字、保留「更多」裡的設定（同一個人通常同一隻手）
function submitLog(e) {
  e.preventDefault();
  const form = $('#log-form');
  const { record, error } = readForm(form, emptyRecord());
  if (error) return showError($('#log-error'), error);
  showError($('#log-error'), '');
  buzz(30);
  save(record, true);
  for (const name of NUMERIC_FIELDS) form.elements[name].value = '';
  logTimeMode = 'now';
  form.elements.time.value = '';
  renderLogTime();
  afterSave(record);
  form.elements.systolic.blur();
}

// 存檔後的回饋：提示分級；非常高時另外顯示就醫提醒（留在畫面上，不會自己消失）
function afterSave(r) {
  const cat = classify(r.systolic, r.diastolic);
  toast(t('log.saved', { bp: bpText(r.systolic, r.diastolic), cat: t(`cat.${cat}`) }), 4000);
  const note = $('#crisis-note');
  note.hidden = cat !== 'crisis';
  if (cat === 'crisis') note.textContent = t('log.crisis');
}

// 編輯 / 補登對話框
function openForm(record, preset = {}) {
  editing = record;
  const form = $('#record-form');
  $('#form-title').textContent = t(record ? 'form.titleEdit' : 'form.titleNew');
  fillForm(form, record ?? { ...emptyRecord(), ...preset });
  form.elements.time.max = nowLocal();
  $('#btn-delete').hidden = !record;
  showError($('#form-error'), '');
  $('#record-dialog').showModal();
  if (!record) form.elements.systolic.focus();
}

function submitForm(e) {
  e.preventDefault();
  const form = $('#record-form');
  if (!form.elements.time.value) return showError($('#form-error'), t('log.required'));
  const { record, error } = readForm(form, editing ?? emptyRecord());
  if (error) return showError($('#form-error'), error);
  save(record, !editing);
  $('#record-dialog').close();
  afterSave(record);
}

function deleteEditing() {
  if (!editing) return;
  const record = editing;
  $('#record-dialog').close();
  deleteWithUndo(record);
}

// ---------- 清空所有紀錄 ----------

function openClearDialog() {
  const n = store.getRecords().length;
  const linked = !!auth.getEmail();
  $('#clear-body').textContent = t(linked ? 'clear.body' : 'clear.bodyLocal', { n });
  $('#clear-restore').textContent = t(linked ? 'clear.restore' : 'clear.restoreLocal');
  $('#clear-hint').textContent = t('clear.typeHint', { word: t('clear.word') });
  $('#clear-input').value = '';
  $('#btn-clear-confirm').disabled = true;
  $('#clear-error').hidden = true;
  $('#clear-dialog').showModal();
}

function onClearInput() {
  $('#btn-clear-confirm').disabled = $('#clear-input').value.trim().toLowerCase() !== t('clear.word').toLowerCase();
}

// 先清試算表、成功後才清本機；失敗時什麼都不刪。
// 有綁定帳號但權杖過期時，必須在這個點擊事件中同步開啟登入彈窗。
function confirmClear(e) {
  e.preventDefault();
  if ($('#btn-clear-confirm').disabled) return;
  const linked = !!auth.getEmail();
  const tokenPromise = !linked ? Promise.resolve(null)
    : auth.hasValidToken() ? Promise.resolve(auth.getToken())
    : auth.requestToken();
  $('#btn-clear-confirm').disabled = true;
  tokenPromise
    .then(async (token) => {
      await store.whenIdle();
      if (token) {
        if (!sheet) {
          sheet = await openSpreadsheet(token, { cachedId: store.getCachedSheetId(), title: t('app.sheetTitle') });
          store.setCachedSheetId(sheet.id);
        }
        await sheet.clearAll(token);
      }
      store.clearRecords();
      $('#clear-dialog').close();
      toast(t('clear.done'));
    })
    .catch((err) => {
      console.error(err);
      $('#clear-error').textContent = t('clear.failed');
      $('#clear-error').hidden = false;
      onClearInput();
    });
}

// ---------- 匯出 / 匯入 ----------

function exportRecords() {
  const records = store.getRecords();
  const blob = new Blob([JSON.stringify(buildExport(records), null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `bpack-${localDate(new Date())}.json`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast(t('export.done', { n: records.length }));
}

// 匯入：AI 整理 → 貼上 → 預覽 → 匯入；或直接選擇本網站匯出的 JSON 檔
let importPrompt = '';
let pendingImport = [];

function openImport() {
  importPrompt = buildPrompt();
  const links = aiLinks(importPrompt);
  $('#ai-chatgpt').href = links.chatgpt;
  $('#ai-claude').href = links.claude;
  $('#import-text').value = '';
  previewImport();
  $('#import-dialog').showModal();
}

function copyPrompt() {
  navigator.clipboard.writeText(importPrompt)
    .then(() => toast(t('import.copied')))
    .catch((e) => console.warn('clipboard', e));
}

// 貼上後即時解析與預覽
function previewImport() {
  const text = $('#import-text').value.trim();
  const box = $('#import-preview');
  const btn = $('#btn-import-confirm');
  pendingImport = [];
  btn.disabled = true;
  btn.textContent = t('import.title');
  if (!text) {
    box.innerHTML = '';
    return;
  }
  let result;
  try {
    result = parseImport(text, store.getRecords());
  } catch {
    box.innerHTML = `<p class="error">${escapeHtml(t('import.noJson'))}</p>`;
    return;
  }
  pendingImport = result.records;
  const n = pendingImport.length;
  const shown = pendingImport.slice(0, 20).map((r) => `<li>${escapeHtml(`${formatDateTime(r.time)} · ${bpText(r.systolic, r.diastolic)}${r.pulse != null ? ` · ${t('list.pulse', { n: r.pulse })}` : ''}`)}</li>`).join('');
  box.innerHTML = `
    <p class="ok">${escapeHtml(t('import.ready', { n }))}</p>
    ${result.duplicates ? `<p class="muted small">${escapeHtml(t('import.duplicates', { n: result.duplicates }))}</p>` : ''}
    ${result.errors.length ? `<p class="error small">${escapeHtml(t('import.errors', { n: result.errors.length }))}</p>` : ''}
    ${n ? `<ul>${shown}${n > 20 ? `<li class="muted">${escapeHtml(t('import.more', { n: n - 20 }))}</li>` : ''}</ul>` : ''}`;
  btn.disabled = !n;
  btn.textContent = t('import.confirm', { n });
}

function confirmImport(e) {
  e.preventDefault();
  if (!pendingImport.length) return;
  const now = new Date().toISOString();
  const list = pendingImport.map((r) => ({ ...r, created_at: now, updated_at: now }));
  store.importRecords(list);
  pendingImport = [];
  $('#import-dialog').close();
  toast(t('import.done', { n: list.length }));
  showView('list');
  trySync();
}

// ---------- 日曆 ----------
//
// 一次一個月，‹ › 或左右滑動切換，月份標籤是原生的年月選擇器；旁邊的明細面板
// 沒選日期時列出整個月的紀錄，選了日期就列出當天的紀錄，並可從那天補登。

const thisMonth = () => localDate(new Date()).slice(0, 7);
const shiftMonth = (ym, n) => localDate(new Date(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)) - 1 + n, 1)).slice(0, 7);
let calMonth = thisMonth(); // 'YYYY-MM'
let calSelected = null; // 'YYYY-MM-DD'

function goCal({ month = calMonth, selected = null } = {}) {
  calMonth = month > thisMonth() ? thisMonth() : month;
  calSelected = selected;
  renderCalendarView();
}

function renderCalendarView() {
  const input = $('#cal-month-input');
  input.max = thisMonth();
  if (document.activeElement !== input && input.value !== calMonth) input.value = calMonth;
  $('#cal-next').disabled = calMonth >= thisMonth();
  $('#cal-today').hidden = calMonth === thisMonth();
  $('#calendar-month').innerHTML = calendarHtml({ records: store.getRecords(), month: calMonth, lang: getLang(), t, selected: calSelected });
  renderDayDetail();
}

function renderCalLegend() {
  const sample = (m, e, other = 0) => circleSvg({ morning: m && { cat: m }, evening: e && { cat: e }, other }, { small: true });
  $('#cal-legend').innerHTML = `
    <span>${sample('normal', 'stage1')}${escapeHtml(`${t('cal.legendTop')} · ${t('cal.legendBottom')}`)}</span>
    <span>${sample('normal', null)}${escapeHtml(t('cal.legendEmpty'))}</span>
    <span>${sample('normal', 'normal', 1)}${escapeHtml(t('cal.legendOther'))}</span>
    <span class="cal-legend-cats">${CATEGORIES.map((c) => `<i class="cat-dot cat-${c}"></i>${escapeHtml(t(`cat.${c}`))}`).join(' ')}</span>`;
}

function renderDayDetail() {
  const panel = $('#cal-detail');
  const all = store.getRecords();
  const items = (calSelected
    ? all.filter((r) => dayOf(r.time) === calSelected)
    : all.filter((r) => r.time?.startsWith(calMonth)))
    .sort((a, b) => b.time.localeCompare(a.time));
  const title = calSelected ? formatDay(calSelected) : t('cal.monthEntries', { n: items.length });
  panel.innerHTML = `
    <div class="cal-detail-head">
      <h4>${escapeHtml(title)}</h4>
      ${calSelected ? `<button type="button" class="link-btn" data-clear-day>${escapeHtml(t('cal.showMonth'))}</button>` : ''}
    </div>
    ${items.length
      ? `<ul class="reading-list">${items.map((r) => readingHtml(r, { showDate: !calSelected })).join('')}</ul>`
      : `<p class="muted small">${escapeHtml(t(calSelected ? 'cal.noEntries' : 'cal.noEntriesMonth'))}</p>`}
    ${calSelected ? `<button type="button" class="btn ghost small" data-add-day="${calSelected}">＋ ${escapeHtml(t('cal.addForDay'))}</button>` : ''}`;
}

// 點日期：只更新選取與明細（不重繪整個月曆）
function selectDay(day) {
  calSelected = calSelected === day ? null : day;
  document.querySelectorAll('#calendar-month .cal-day.selected').forEach((b) => {
    b.classList.remove('selected');
    b.setAttribute('aria-pressed', 'false');
  });
  const btn = calSelected && $('#calendar-month').querySelector(`[data-day="${calSelected}"]`);
  btn?.classList.add('selected');
  btn?.setAttribute('aria-pressed', 'true');
  renderDayDetail();
  const panel = $('#cal-detail');
  if (calSelected && panel.getBoundingClientRect().top > window.innerHeight - 120) panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
function slideCalendar(dir) {
  if (reduceMotion.matches) return;
  const x = dir * (document.documentElement.dir === 'rtl' ? -1 : 1) * 24;
  $('#calendar-month').animate(
    [{ transform: `translateX(${x}px)`, opacity: 0 }, { transform: 'none', opacity: 1 }],
    { duration: 200, easing: 'cubic-bezier(.2, .8, .2, 1)' },
  );
}

function stepCalendar(n) {
  const before = calMonth;
  goCal({ month: shiftMonth(calMonth, n) });
  if (calMonth !== before) slideCalendar(n);
}

function onCalendarClick(e) {
  const el = e.target.closest('#cal-prev,#cal-next,#cal-today,[data-day],[data-clear-day],li[data-id],[data-add-day]');
  if (!el) return;
  if (el.id === 'cal-prev') return stepCalendar(-1);
  if (el.id === 'cal-next') return stepCalendar(1);
  if (el.id === 'cal-today') {
    goCal({ month: thisMonth() });
    return slideCalendar(1);
  }
  if (el.dataset.day) return selectDay(el.dataset.day);
  if (el.hasAttribute('data-clear-day')) return goCal();
  if (el.dataset.id) return openForm(store.getRecords().find((r) => r.id === el.dataset.id));
  // 補登：日期用選取的那天，時間先帶早上 7 點
  if (el.dataset.addDay) openForm(null, { time: `${el.dataset.addDay}T07:00` });
}

// 左右滑動切換月份（往右滑 = 上個月）
function bindCalendarSwipe() {
  const box = $('#calendar-month');
  let x0 = null;
  let y0 = null;
  box.addEventListener('touchstart', (e) => { [x0, y0] = [e.touches[0].clientX, e.touches[0].clientY]; }, { passive: true });
  box.addEventListener('touchend', (e) => {
    if (x0 == null) return;
    const dx = e.changedTouches[0].clientX - x0;
    const dy = e.changedTouches[0].clientY - y0;
    x0 = null;
    if (Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    const rtl = document.documentElement.dir === 'rtl';
    stepCalendar((dx > 0) !== rtl ? -1 : 1);
  }, { passive: true });
}

// ---------- 畫面 ----------

function renderSync() {
  const hasToken = auth.hasValidToken();
  const email = auth.getEmail();
  const pending = store.pendingCount();
  const status = $('#sync-status');
  const banner = $('#banner');

  let kind = '';
  let text = '';
  if (syncState === 'syncing') [kind, text] = ['cloudSync', t('sync.syncing')];
  else if (syncState === 'offline' || syncState === 'error') [kind, text] = ['cloudOff', t(syncState === 'offline' ? 'sync.offline' : 'sync.failed')];
  else if (pending && CLIENT_ID) [kind, text] = [hasToken ? 'cloudUp' : 'cloudOff', t('sync.pending', { n: pending })];
  else if (hasToken) [kind, text] = ['cloudCheck', t('sync.synced')];
  status.innerHTML = kind ? `${icon(kind)}${pending ? `<span class="sync-count">${pending}</span>` : ''}<span class="sync-text">${escapeHtml(text)}</span>` : '';
  status.title = text;
  status.setAttribute('aria-label', text);
  status.dataset.kind = kind;

  const signinBtn = $('#btn-signin');
  signinBtn.hidden = hasToken || !CLIENT_ID;
  signinBtn.disabled = !authReady;
  const full = t(email ? 'auth.reconnect' : 'auth.signIn');
  const short = email ? full : t('auth.signInShort');
  signinBtn.innerHTML = `<span class="label-full">${escapeHtml(full)}</span><span class="label-short">${escapeHtml(short)}</span>`;
  signinBtn.title = full;
  $('#btn-sync').hidden = !hasToken || !pending || syncState === 'syncing';

  let msg = '';
  if (!CLIENT_ID) msg = t('auth.notConfigured');
  else if (!email && !(document.body.dataset.view === 'log' && needsBackup())) msg = t('auth.localOnly');
  else if (syncState === 'error') msg = t('sync.failed');
  else if (syncState === 'offline') msg = t('sync.offline');
  banner.textContent = msg;
  banner.hidden = !msg;
}

// 一筆紀錄的一列：級別色點、時段與時間、血壓、心跳、情境
function readingHtml(r, { showDate = false } = {}) {
  const cat = classify(r.systolic, r.diastolic);
  const period = periodOf(r.time);
  const when = showDate ? formatDateTime(r.time) : `${t(`period.${period}`)} ${formatTime(r.time)}`;
  const tags = [
    r.arm ? t(`opt.arm.${r.arm}`) : '',
    ...(r.tags ?? []).map((x) => t(`opt.tags.${x}`)),
  ].filter(Boolean);
  return `
    <li class="reading" data-id="${escapeHtml(r.id)}">
      <span class="cat-dot cat-${cat}" title="${escapeHtml(t(`cat.${cat}`))}"></span>
      <span class="reading-when">${icon(period === 'morning' ? 'sun' : period === 'evening' ? 'moon' : 'clock')}${escapeHtml(when)}</span>
      <span class="reading-bp"><strong>${r.systolic}</strong><span class="bp-sep">/</span><strong>${r.diastolic}</strong></span>
      <span class="reading-pulse">${r.pulse != null ? `${icon('heart')}${r.pulse}` : ''}</span>
      ${tags.length || r.notes ? `<span class="reading-tags">${tags.map((x) => `<span class="tag">${escapeHtml(x)}</span>`).join('')}${r.notes ? `<span class="tag note">${escapeHtml(r.notes)}</span>` : ''}</span>` : ''}
    </li>`;
}

function renderToday() {
  const today = localDate(new Date());
  const list = store.getRecords().filter((r) => dayOf(r.time) === today).sort((a, b) => a.time.localeCompare(b.time));
  $('#today-list').innerHTML = list.length
    ? list.map((r) => readingHtml(r)).join('')
    : `<li class="muted small">${escapeHtml(t('log.noToday'))}</li>`;
}

// 最近 7 天：平均與分級、722 習慣
function renderWeek() {
  const today = localDate(new Date());
  const from = localDate(new Date(Date.now() - 6 * 86400000));
  const records = inRange(store.getRecords(), from, today);
  const card = $('#week-card');
  card.hidden = !records.length;
  if (!records.length) return;
  const a = average(records);
  const cat = classify(a.systolic, a.diastolic);
  const habit = sevenTwoTwo(store.getRecords(), today);
  $('#week-body').innerHTML = `
    <div class="week-avg">
      <span class="week-bp cat-text-${cat}">${a.systolic}<span class="bp-sep">/</span>${a.diastolic}</span>
      <span class="cat-badge cat-${cat}">${escapeHtml(t(`cat.${cat}`))}</span>
      ${a.pulse != null ? `<span class="muted small">${icon('heart')} ${a.pulse}</span>` : ''}
    </div>
    <p class="muted small">${escapeHtml(t('log.habit', { both: habit.both }))}<br>${escapeHtml(t('log.habitHint'))}</p>`;
}

// 列表只先顯示最近幾天，避免紀錄多時頁面超長
const LIST_INITIAL = 14;
const LIST_STEP = 30;
let listLimit = LIST_INITIAL;

function renderList() {
  const all = store.getRecords();
  if (!all.length) {
    $('#record-list').innerHTML = `<li class="muted">${escapeHtml(t('list.empty'))}</li>`;
    return;
  }
  const days = [...groupByDay(all).entries()].reverse(); // 新的在前
  const shown = days.slice(0, listLimit);
  const rows = shown.map(([day, list]) => {
    const a = average(list);
    const cat = classify(a.systolic, a.diastolic);
    const items = [...list].sort((x, y) => y.time.localeCompare(x.time)).map((r) => readingHtml(r)).join('');
    return `
      <li class="list-day">
        <span class="list-day-name">${escapeHtml(formatDay(day))}</span>
        ${list.length > 1 ? `<span class="list-day-avg cat-text-${cat}">${escapeHtml(t('list.dayAvg', { bp: bpText(a.systolic, a.diastolic) }))}</span>` : ''}
      </li>${items}`;
  });
  const rest = days.length - shown.length;
  $('#record-list').innerHTML = rows.join('')
    + (rest > 0 ? `<li class="list-more"><button type="button" class="btn ghost wide" data-more>${escapeHtml(t('list.more', { n: Math.min(rest, LIST_STEP) }))}</button></li>` : '');
}

// 有紀錄但還沒登入：首頁顯示「尚未備份」卡片
const needsBackup = () => !!CLIENT_ID && !auth.getEmail() && store.getRecords().length > 0;
function renderBackupCard() {
  const show = needsBackup();
  $('#backup-card').hidden = !show;
  if (show) $('#backup-body').textContent = t('backup.body', { n: store.getRecords().length });
  $('#btn-backup').disabled = !authReady;
}

function renderTagline() {
  $('#tagline').hidden = store.getRecords().length > 0;
}

// ---------- 加到主畫面 ----------

let installPrompt = null;
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

function renderInstall() {
  $('#btn-install').hidden = isStandalone();
}

async function install() {
  if (installPrompt) {
    installPrompt.prompt();
    const { outcome } = await installPrompt.userChoice;
    installPrompt = null;
    if (outcome === 'accepted') toast(t('install.done'));
    return;
  }
  const steps = isIOS()
    ? [`${icon('share')} ${escapeHtml(t('install.ios1'))}`, `${icon('addBox')} ${escapeHtml(t('install.ios2'))}`]
    : /Android/i.test(navigator.userAgent)
      ? [escapeHtml(t('install.android'))]
      : [escapeHtml(t('install.desktop', { key: /Mac/i.test(navigator.platform) ? '⌘ + D' : 'Ctrl + D' }))];
  $('#install-steps').innerHTML = steps.map((s) => `<li>${s}</li>`).join('');
  $('#install-dialog').showModal();
}

function renderSettings() {
  const theme = window.bpackTheme?.get() ?? 'system';
  document.querySelectorAll('[data-theme-choice]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.themeChoice === theme)));
  const email = auth.getEmail();
  $('#account-email').textContent = email || t(CLIENT_ID ? 'auth.localOnly' : 'auth.notConfigured');
  $('#btn-signout').hidden = !email;
  $('#btn-clear').disabled = !store.getRecords().length;
  $('#btn-export').disabled = !store.getRecords().length;
  const link = $('#sheet-link');
  link.hidden = !sheet;
  if (sheet) link.href = sheet.url;
}

let statsView = null;

function render() {
  renderSync();
  renderInstall();
  renderToday();
  renderWeek();
  renderBackupCard();
  renderTagline();
  renderList();
  if (document.body.dataset.view === 'calendar') renderCalendarView(); // 隱藏時不畫，切過去時再畫
  statsView?.render();
  renderSettings();
}

// 語言切換後重建由 JS 產生的文字（靜態文字由 i18n.applyI18n 處理）
function refreshLanguage() {
  $('#copyright').textContent = t('footer.copyright', { year: new Date().getFullYear() });
  $('#footer-version').textContent = `v${APP_VERSION}`;
  $('#app-version').textContent = t('settings.version', { v: APP_VERSION });
  buildForms();
  renderCalLegend();
  render();
}

function showView(name) {
  document.body.dataset.view = name;
  renderSync();
  window.scrollTo(0, 0);
  if (name === 'stats') statsView?.render(); // 隱藏時量不到圖表寬度，切過來再畫一次
  if (name === 'calendar') renderCalendarView();
  document.querySelectorAll('.nav button').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
}

// ---------- 啟動 ----------

function bindEvents() {
  $('#btn-signin').addEventListener('click', signIn);
  $('#btn-sync').addEventListener('click', trySync);
  $('#btn-signout').addEventListener('click', signOut);
  $('#btn-backup').addEventListener('click', signIn);
  $('#fab').addEventListener('click', () => openForm(null));

  const logForm = $('#log-form');
  logForm.addEventListener('submit', submitLog);
  logForm.addEventListener('click', (e) => { if (e.target.closest('[data-toggle-time]')) toggleLogTime(); });
  // 每分鐘更新「現在」的時間文字
  setInterval(() => { if (logTimeMode === 'now') renderLogTime(); }, 30000);

  // 單選膠囊：點已選的那一個可以取消（radio 預設不能取消）
  for (const form of [logForm, $('#record-form')]) {
    form.addEventListener('pointerdown', (e) => {
      const input = e.target.closest('label.chip')?.querySelector('input[type="radio"]');
      if (input) input.dataset.wasChecked = String(input.checked);
    });
    form.addEventListener('click', (e) => {
      const input = e.target.closest('input[type="radio"]');
      if (input?.dataset.wasChecked === 'true') input.checked = false;
      if (input) delete input.dataset.wasChecked;
    });
  }

  $('#record-form').addEventListener('submit', submitForm);
  $('#btn-cancel').addEventListener('click', () => $('#record-dialog').close());
  $('#btn-delete').addEventListener('click', deleteEditing);

  const openById = (e) => {
    const li = e.target.closest('li[data-id]');
    if (li) openForm(store.getRecords().find((r) => r.id === li.dataset.id));
  };
  $('#today-list').addEventListener('click', openById);
  $('#record-list').addEventListener('click', (e) => {
    if (e.target.closest('[data-more]')) {
      listLimit += LIST_STEP;
      return renderList();
    }
    openById(e);
  });

  statsView = createStatsView($('#view-stats'), { t, getLang, getRecords: store.getRecords });

  $('.theme-seg').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-theme-choice]');
    if (!btn) return;
    window.bpackTheme?.set(btn.dataset.themeChoice);
    renderSettings();
  });

  $('#btn-clear').addEventListener('click', openClearDialog);
  $('#clear-input').addEventListener('input', onClearInput);
  $('#clear-form').addEventListener('submit', confirmClear);
  $('#btn-clear-cancel').addEventListener('click', () => $('#clear-dialog').close());

  $('#btn-install').addEventListener('click', install);
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    installPrompt = e;
  });
  window.addEventListener('appinstalled', () => {
    installPrompt = null;
    renderInstall();
  });

  $('#btn-export').addEventListener('click', exportRecords);
  $('#btn-import').addEventListener('click', openImport);
  $('#btn-copy-prompt').addEventListener('click', copyPrompt);
  $('#import-text').addEventListener('input', previewImport);
  // 直接選擇匯出的 JSON 檔：讀進文字框，沿用同一套解析與預覽
  $('#import-file').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    $('#import-text').value = await file.text();
    e.target.value = '';
    previewImport();
  });
  $('#import-form').addEventListener('submit', confirmImport);
  $('#btn-import-close').addEventListener('click', () => $('#import-dialog').close());

  $('#view-calendar').addEventListener('click', onCalendarClick);
  $('#cal-month-input').addEventListener('change', (e) => { if (e.target.value) goCal({ month: e.target.value }); });
  bindCalendarSwipe();

  const langSelect = $('#lang-select');
  langSelect.innerHTML = Object.entries(LANGS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
  langSelect.addEventListener('change', async () => {
    await setLang(langSelect.value);
    refreshLanguage();
  });

  document.querySelectorAll('.nav button').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));

  window.addEventListener('online', trySync);
  window.addEventListener('offline', () => { syncState = 'offline'; renderSync(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') trySync(); });
  store.onChange(render);
}

async function init() {
  applyIcons();
  bindEvents();
  await initI18n();
  $('#lang-select').value = getLang();
  refreshLanguage();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW', e));
  if (CLIENT_ID) {
    try {
      await auth.initAuth();
      authReady = true;
    } catch (e) {
      console.warn('GIS unavailable (offline?)', e); // 離線時仍可本機記錄
    }
  }
  render();
  trySync();
}

init();
