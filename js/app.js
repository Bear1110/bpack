import * as auth from './auth.js';
import * as store from './store.js';
import { openSpreadsheet, fetchEmail, ApiError } from './sheets.js';
import { OPTIONS, LIMITS, NUMERIC_FIELDS, newId } from './schema.js';
import { CLIENT_ID } from './config.js';
import { t, getLang, setLang, initI18n, LANGS, dateLabel, clockLabel } from './i18n.js';
import { localDate, dayOf, pad, parseDay, addDays, bpText, classify, periodOf, average, groupByDay, inRange, sevenTwoTwo, CATEGORIES } from './stats.js';
import { createStatsView } from './statsview.js';
import { renderCalendar as calendarHtml, circleSvg } from './calendar.js';
import { buildPrompt, parseImport, buildExport } from './importer.js';
import { AI_PRESETS, AI_DAYS, buildAnalysisPrompt, aiLinks } from './aianalysis.js';
import { applyIcons, icon } from './icons.js';
import { esc, catDot, chipHtml } from './html.js';
import { APP_VERSION } from './version.js';

const $ = (sel) => document.querySelector(sel);
const isRtl = () => document.documentElement.dir === 'rtl';
// 一組 role=radio 按鈕：依 data-* 的值同步 aria-checked
const syncRadios = (selector, key, value) => document.querySelectorAll(selector).forEach((b) => b.setAttribute('aria-checked', String(b.dataset[key] === value)));
const CLOUD = !!CLIENT_ID; // 沒設定 Google 用戶端時只做本機記錄

let sheet = null;
let syncState = 'idle'; // idle | syncing | error | offline
let authReady = false;
let editing = null; // 對話框正在編輯的紀錄

function nowLocal() {
  const d = new Date();
  return `${localDate(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${dateLabel(d)} ${clockLabel(d)}`;
}

function formatDay(day) {
  const d = parseDay(day);
  return dateLabel(d);
}

const formatTime = (iso) => clockLabel(new Date(iso));

let toastTimer;
// action：{ label, run }，例如「復原」；有按鈕時停留久一點
function toast(msg, ms = 3000, action = null) {
  const el = $('#toast');
  el.innerHTML = `<span>${esc(msg)}</span>${action ? `<button type="button" class="toast-action">${icon(action.icon ?? 'undo')}${esc(action.label)}</button>` : ''}`;
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

// 存檔、同步時 store 會連續通知好幾次，合併到下一個畫面更新再重畫一次
let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
}

// 試算表只開一次，之後沿用
async function ensureSheet(token) {
  if (!sheet) {
    sheet = await openSpreadsheet(token, { cachedId: store.getCachedSheetId(), title: t('app.sheetTitle') });
    store.setCachedSheetId(sheet.id);
  }
  return sheet;
}

// ---------- 同步 ----------

async function trySync() {
  if (store.isDemo()) return scheduleRender(); // 示範模式完全不連外
  const token = auth.getToken();
  if (!token) return scheduleRender();
  if (!navigator.onLine) {
    syncState = 'offline';
    return scheduleRender();
  }
  syncState = 'syncing';
  renderSync();
  try {
    await ensureSheet(token);
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
  scheduleRender();
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

// ---------- 血壓藥 ----------
//
// 「我有在吃血壓藥」是長期設定；「今天吃了沒」以天為單位記住：
// 早上量時是「還沒吃」，點過「吃了」之後當天的紀錄都算吃藥後，隔天自動回到「還沒吃」。
// 吃藥前（早上）的血壓是醫師最想看的數字，所以不能只是記住上一次的勾選。

const MEDS_KEY = 'bp.meds';
const MEDS_TODAY_KEY = 'bp.medsToday';
const MED_TAGS = ['before_meds', 'after_meds'];

const getMedsPref = () => ({ on: false, name: '', ...store.readJson(MEDS_KEY, {}) });
const setMedsPref = (patch) => store.writeJson(MEDS_KEY, { ...getMedsPref(), ...patch });
function medsTakenToday() {
  try { return localStorage.getItem(MEDS_TODAY_KEY) === localDate(new Date()); } catch { return false; }
}
function setMedsTaken(taken) {
  try {
    if (taken) localStorage.setItem(MEDS_TODAY_KEY, localDate(new Date()));
    else localStorage.removeItem(MEDS_TODAY_KEY);
  } catch { /* ignore */ }
}

// ---------- 表單（首頁與編輯對話框共用同一組欄位） ----------

// dialog：編輯對話框一律顯示時間欄並保留完整的情境選項；首頁改用「現在／改時間」，
// 有在吃藥時用「今天的血壓藥」開關取代吃藥前／後兩個情境（開關本身就是 tags 的 radio，readForm 直接讀得到）
function fieldsHtml({ dialog }) {
  const num = (name, hint, unit, placeholder, big = true) => `
    <label class="bp-field ${big ? 'big' : 'pulse'}">
      <span class="bp-label">${esc(t(`log.${name}`))} <small>${esc(t(`log.${hint}`))}</small></span>
      <span class="bp-input">
        <input type="number" inputmode="numeric" name="${name}" min="${LIMITS[name][0]}" max="${LIMITS[name][1]}" step="1" placeholder="${placeholder}" autocomplete="off">
        <span class="bp-unit">${esc(t(unit))}</span>
      </span>
    </label>`;
  const meds = getMedsPref();
  const medsSwitch = !dialog && meds.on;
  const chips = (field, type) => OPTIONS[field].filter((c) => !(medsSwitch && MED_TAGS.includes(c)))
    .map((c) => chipHtml(type, field, c, t(`opt.${field}.${c}`))).join('');
  const taken = medsTakenToday();
  const medsRow = medsSwitch ? `
    <div class="meds-row">
      <span class="meds-label">${icon('pill')}${esc(t('log.medsToday'))}${meds.name ? ` <small>${esc(meds.name)}</small>` : ''}</span>
      <div class="seg meds-seg" role="radiogroup" aria-label="${esc(t('log.medsToday'))}">
        <label><input type="radio" name="tags" value="before_meds"${taken ? '' : ' checked'}><span>${esc(t('log.medsNo'))}</span></label>
        <label><input type="radio" name="tags" value="after_meds"${taken ? ' checked' : ''}><span>${esc(t('log.medsYes'))}</span></label>
      </div>
    </div>` : '';
  return `
    <div class="bp-inputs">
      ${num('systolic', 'systolicHint', 'log.unit', '120')}
      <span class="bp-slash" aria-hidden="true">/</span>
      ${num('diastolic', 'diastolicHint', 'log.unit', '80')}
      ${num('pulse', 'pulseHint', 'log.pulseUnit', '70', false)}
    </div>
    ${dialog
      ? `<label class="field"><span>${esc(t('log.time'))}</span><input type="datetime-local" name="time" required></label>`
      : `<div class="log-time">
          ${icon('clock')}<span class="log-time-text" data-time-text></span>
          <button type="button" class="link-btn" data-toggle-time>${esc(t('log.changeTime'))}</button>
          <input type="datetime-local" name="time" class="log-time-input" hidden aria-label="${esc(t('log.time'))}">
        </div>`}
    ${medsRow}
    <details class="log-more">
      <summary>${esc(t('log.more'))}</summary>
      <fieldset class="field"><legend>${esc(t('log.arm'))}</legend><div class="chips">${chips('arm', 'radio')}</div></fieldset>
      <fieldset class="field"><legend>${esc(t('log.tags'))}</legend><div class="chips">${chips('tags', 'checkbox')}</div></fieldset>
      <label class="field"><span>${esc(t('log.notes'))}</span><textarea name="notes" rows="2"></textarea></label>
    </details>`;
}

function buildForms() {
  $('#log-fields').innerHTML = fieldsHtml({ dialog: false });
  $('#form-fields').innerHTML = fieldsHtml({ dialog: true });
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
  if (!f.time.value) return { error: t('log.required') };
  const record = {
    ...base,
    time: f.time.value,
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
  f.time.value = r.time || '';
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
  if (logTimeMode === 'now') form.elements.time.value = nowLocal(); // 存檔那一刻才取時間
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
      if (token) await (await ensureSheet(token)).clearAll(token);
      store.clearRecords();
      $('#clear-dialog').close();
      toast(t('clear.done'));
    })
    .catch((err) => {
      console.error(err);
      showError($('#clear-error'), t('clear.failed'));
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
    box.innerHTML = `<p class="error">${esc(t('import.noJson'))}</p>`;
    return;
  }
  pendingImport = result.records;
  const n = pendingImport.length;
  const shown = pendingImport.slice(0, 20).map((r) => `<li>${esc(`${formatDateTime(r.time)} · ${bpText(r.systolic, r.diastolic)}${r.pulse != null ? ` · ${t('list.pulse', { n: r.pulse })}` : ''}`)}</li>`).join('');
  box.innerHTML = `
    <p class="ok">${esc(t('import.ready', { n }))}</p>
    ${result.duplicates ? `<p class="muted small">${esc(t('import.duplicates', { n: result.duplicates }))}</p>` : ''}
    ${result.errors.length ? `<p class="error small">${esc(t('import.errors', { n: result.errors.length }))}</p>` : ''}
    ${n ? `<ul>${shown}${n > 20 ? `<li class="muted">${esc(t('import.more', { n: n - 20 }))}</li>` : ''}</ul>` : ''}`;
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
  $('#cal-today').disabled = calMonth === thisMonth();
  const records = store.getRecords().filter((r) => r.time?.startsWith(calMonth));
  $('#calendar-month').innerHTML = calendarHtml({ records, month: calMonth, lang: getLang(), t, selected: calSelected });
  renderDayDetail();
}

function renderCalLegend() {
  const sample = (m, e, other = 0) => circleSvg({ morning: m && { cat: m }, evening: e && { cat: e }, other }, { small: true });
  $('#cal-legend').innerHTML = `
    <span>${sample('normal', 'stage1')}${esc(`${t('cal.legendTop')} · ${t('cal.legendBottom')}`)}</span>
    <span>${sample('normal', null)}${esc(t('cal.legendEmpty'))}</span>
    <span>${sample('normal', 'normal', 1)}${esc(t('cal.legendOther'))}</span>
    <span>${circleSvg({ morning: { cat: 'normal' }, evening: { cat: 'normal' }, meds: true }, { small: true })}${esc(t('cal.legendMeds'))}</span>
    <span class="cal-legend-cats">${CATEGORIES.map((c) => `${catDot(c)}${esc(t(`cat.${c}`))}`).join(' ')}</span>`;
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
      <h4>${esc(title)}</h4>
      ${calSelected ? `<button type="button" class="link-btn" data-clear-day>${esc(t('cal.showMonth'))}</button>` : ''}
    </div>
    ${items.length
      ? `<ul class="reading-list">${items.map((r) => readingHtml(r, { showDate: !calSelected })).join('')}</ul>`
      : `<p class="muted small">${esc(t(calSelected ? 'cal.noEntries' : 'cal.noEntriesMonth'))}</p>`}
    ${calSelected ? `<button type="button" class="btn ghost small" data-add-day="${calSelected}">＋ ${esc(t('cal.addForDay'))}</button>` : ''}`;
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
  const x = dir * (isRtl() ? -1 : 1) * 24;
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
  if (el.dataset.id) return openRecord(el.dataset.id);
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
    stepCalendar((dx > 0) !== isRtl() ? -1 : 1);
  }, { passive: true });
}

// ---------- AI 分析 ----------

const AI_KEY = 'bp.ai';
let aiPrompt = '';
const aiState = { preset: 'overview', days: 30, notes: true, ...store.readJson(AI_KEY, {}) };

function openAiDialog() {
  const preset = AI_PRESETS.includes(aiState.preset) ? aiState.preset : AI_PRESETS[0];
  const days = AI_DAYS.includes(aiState.days) ? aiState.days : AI_DAYS[0];
  $('#ai-presets').innerHTML = AI_PRESETS.map((p) => chipHtml('radio', 'ai-preset', p, t(`ai.p_${p}`), p === preset)).join('');
  $('#ai-days').innerHTML = AI_DAYS.map((n) => chipHtml('radio', 'ai-days', n, t('ai.daysN', { n }), n === days)).join('');
  $('#ai-notes').checked = aiState.notes;
  updateAiPrompt();
  $('#ai-dialog').showModal();
}

function updateAiPrompt() {
  aiState.preset = $('#ai-presets input:checked')?.value ?? 'overview';
  aiState.days = Number($('#ai-days input:checked')?.value ?? 30);
  aiState.notes = $('#ai-notes').checked;
  store.writeJson(AI_KEY, aiState);
  const { prompt, count } = buildAnalysisPrompt(store.getRecords(), { ...aiState, includeNotes: aiState.notes, lang: getLang(), medName: getMedsPref().name });
  aiPrompt = prompt;
  const links = aiLinks(prompt);
  $('#ai-open-chatgpt').href = links.chatgpt;
  $('#ai-open-claude').href = links.claude;
  $('#ai-privacy').textContent = t('ai.privacy', { n: count });
  $('#ai-hint').textContent = count ? t(links.fits ? 'ai.hintFilled' : 'ai.hintPaste') : t('ai.noData');
  $('#ai-preview').textContent = prompt;
  for (const el of document.querySelectorAll('#ai-open-chatgpt, #ai-open-claude, #ai-copy')) el.classList.toggle('disabled', !count);
}

// 開啟 AI 前一律先複製（內容太長、網址放不下時，使用者貼上即可）
function copyAiPrompt() {
  if (!aiPrompt) return;
  navigator.clipboard?.writeText(aiPrompt).then(() => toast(t('ai.copied'))).catch(() => {});
}

// ---------- 畫面 ----------

function renderSync() {
  const demo = store.isDemo();
  $('#demo-banner').hidden = !demo;
  if (demo) {
    $('#sync-status').textContent = '';
    $('#btn-signin').hidden = true;
    $('#btn-sync').hidden = true;
    $('#banner').hidden = true;
    return;
  }
  const hasToken = auth.hasValidToken();
  const email = auth.getEmail();
  const pending = store.pendingCount();
  const status = $('#sync-status');
  const banner = $('#banner');

  let kind = '';
  let text = '';
  if (syncState === 'syncing') [kind, text] = ['cloudSync', t('sync.syncing')];
  else if (syncState === 'offline' || syncState === 'error') [kind, text] = ['cloudOff', t(syncState === 'offline' ? 'sync.offline' : 'sync.failed')];
  else if (pending && CLOUD) [kind, text] = [hasToken ? 'cloudUp' : 'cloudOff', t('sync.pending', { n: pending })];
  else if (hasToken) [kind, text] = ['cloudCheck', t('sync.synced')];
  status.innerHTML = kind ? `${icon(kind)}${pending ? `<span class="sync-count">${pending}</span>` : ''}<span class="sync-text">${esc(text)}</span>` : '';
  status.title = text;
  status.setAttribute('aria-label', text);
  status.dataset.kind = kind;

  const signinBtn = $('#btn-signin');
  signinBtn.hidden = hasToken || !CLOUD;
  signinBtn.disabled = !authReady;
  const full = t(email ? 'auth.reconnect' : 'auth.signIn');
  const short = email ? full : t('auth.signInShort');
  signinBtn.innerHTML = `<span class="label-full">${esc(full)}</span><span class="label-short">${esc(short)}</span>`;
  signinBtn.title = full;
  $('#btn-sync').hidden = !hasToken || !pending || syncState === 'syncing';

  let msg = '';
  if (!CLOUD) msg = t('auth.notConfigured');
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
  const when = showDate ? formatDateTime(r.time) : formatTime(r.time); // 時段由圖示表示
  const tag = (cls, content) => `<span class="tag ${cls}">${content}</span>`;
  const tags = [
    r.tags?.includes('after_meds') ? tag('med', `${icon('pill')}${esc(t('opt.tags.after_meds'))}`) : '',
    r.tags?.includes('before_meds') ? tag('med before', esc(t('opt.tags.before_meds'))) : '',
    r.arm ? tag('', esc(t(`opt.arm.${r.arm}`))) : '',
    ...(r.tags ?? []).filter((x) => !MED_TAGS.includes(x)).map((x) => tag('', esc(t(`opt.tags.${x}`)))),
  ].filter(Boolean);
  return `
    <li class="reading" data-id="${esc(r.id)}">
      <i class="cat-dot cat-${cat}" title="${esc(t(`cat.${cat}`))}"></i>
      <span class="reading-when" title="${esc(t(`period.${period}`))}" aria-label="${esc(`${t(`period.${period}`)} ${when}`)}">${icon(period === 'morning' ? 'sun' : period === 'evening' ? 'moon' : 'clock')}${esc(when)}</span>
      <span class="reading-bp"><strong>${r.systolic}</strong><span class="bp-sep">/</span><strong>${r.diastolic}</strong></span>
      <span class="reading-pulse">${r.pulse != null ? `${icon('heart')}${r.pulse}` : ''}</span>
      ${tags.length || r.notes ? `<span class="reading-tags">${tags.join('')}${r.notes ? `<span class="tag note">${esc(r.notes)}</span>` : ''}</span>` : ''}
    </li>`;
}

function renderToday() {
  const today = localDate(new Date());
  const list = store.getRecords().filter((r) => dayOf(r.time) === today).sort((a, b) => b.time.localeCompare(a.time));
  $('#today-list').innerHTML = list.length
    ? list.map((r) => readingHtml(r)).join('')
    : `<li class="muted small">${esc(t('log.noToday'))}</li>`;
}

// 最近 7 天：平均與分級、722 習慣
function renderWeek() {
  const today = localDate(new Date());
  const records = inRange(store.getRecords(), addDays(today, -6), today);
  const card = $('#week-card');
  card.hidden = !records.length;
  if (!records.length) return;
  const a = average(records);
  const cat = classify(a.systolic, a.diastolic);
  const habit = sevenTwoTwo(store.getRecords(), today);
  $('#week-body').innerHTML = `
    <div class="week-avg">
      <span class="week-bp cat-text cat-${cat}">${a.systolic}<span class="bp-sep">/</span>${a.diastolic}</span>
      <span class="cat-badge cat-${cat}">${esc(t(`cat.${cat}`))}</span>
      ${a.pulse != null ? `<span class="muted small">${icon('heart')} ${a.pulse}</span>` : ''}
    </div>
    <p class="muted small">${esc(t('log.habit', { both: habit.both }))}<br>${esc(t('log.habitHint'))}</p>`;
}

// 列表只先顯示最近幾天，避免紀錄多時頁面超長
const LIST_INITIAL = 14;
const LIST_STEP = 30;
let listLimit = LIST_INITIAL;

function renderList() {
  const all = store.getRecords();
  if (!all.length) {
    $('#record-list').innerHTML = `<li class="muted">${esc(t('list.empty'))}</li>`;
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
        <span class="list-day-name">${esc(formatDay(day))}</span>
        ${list.length > 1 ? `<span class="list-day-avg cat-text cat-${cat}">${esc(t('list.dayAvg', { bp: bpText(a.systolic, a.diastolic) }))}</span>` : ''}
      </li>${items}`;
  });
  const rest = days.length - shown.length;
  $('#record-list').innerHTML = rows.join('')
    + (rest > 0 ? `<li class="list-more"><button type="button" class="btn ghost wide" data-more>${esc(t('list.more', { n: Math.min(rest, LIST_STEP) }))}</button></li>` : '');
}

// 有紀錄但還沒登入：首頁顯示「尚未備份」卡片
const needsBackup = () => !store.isDemo() && CLOUD && !auth.getEmail() && store.getRecords().length > 0;
function renderBackupCard() {
  const show = needsBackup();
  $('#backup-card').hidden = !show;
  if (show) $('#backup-body').textContent = t('backup.body', { n: store.getRecords().length });
  $('#btn-backup').disabled = !authReady;
}

function renderTagline() {
  const fresh = !store.getRecords().length && !store.isDemo();
  $('#tagline').hidden = !fresh;
  $('#btn-try-demo').hidden = !fresh;
}

// ---------- 分享網站 ----------

// 只分享網站網址（不含任何紀錄）。支援的瀏覽器叫出系統分享面板，否則複製連結
async function shareSite() {
  const url = document.querySelector('link[rel="canonical"]')?.href ?? location.href;
  const data = { title: t('share.name'), text: t('share.text'), url };
  try {
    if (navigator.share) return await navigator.share(data);
    await navigator.clipboard.writeText(url);
    toast(t('share.copied'));
  } catch (e) {
    if (e?.name !== 'AbortError') toast(t('share.failed')); // 使用者關掉分享面板不算失敗
  }
}

// ---------- 示範模式 ----------

async function enterDemo() {
  const { buildDemoRecords } = await import('./demo.js');
  store.enterDemo(buildDemoRecords());
  location.reload();
}

function exitDemo() {
  store.exitDemo();
  location.reload();
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
    ? [`${icon('share')} ${esc(t('install.ios1'))}`, `${icon('addBox')} ${esc(t('install.ios2'))}`]
    : /Android/i.test(navigator.userAgent)
      ? [esc(t('install.android'))]
      : [esc(t('install.desktop', { key: /Mac/i.test(navigator.platform) ? '⌘ + D' : 'Ctrl + D' }))];
  $('#install-steps').innerHTML = steps.map((s) => `<li>${s}</li>`).join('');
  $('#install-dialog').showModal();
}

// js/theme.js 在 <head> 同步載入，bpackTheme 一定存在
function renderFontSizeChoice() {
  syncRadios('[data-font-size-choice]', 'fontSizeChoice', bpackFontSize.get());
}

function renderThemeChoice() {
  syncRadios('[data-theme-choice]', 'themeChoice', bpackTheme.get());
}

// 點列表、今天、日曆明細裡的一筆 → 編輯
function openRecord(id) {
  openForm(store.getRecords().find((r) => r.id === id));
}

function renderSettings() {
  $('#btn-demo').textContent = t(store.isDemo() ? 'demo.exit' : 'demo.enter');
  const meds = getMedsPref();
  $('#meds-toggle').checked = meds.on;
  if (document.activeElement !== $('#meds-name')) $('#meds-name').value = meds.name;
  $('#meds-name').closest('.meds-name').hidden = !meds.on;
  renderThemeChoice();
  renderFontSizeChoice();
  const email = auth.getEmail();
  $('#account-email').textContent = email || t(CLOUD ? 'auth.localOnly' : 'auth.notConfigured');
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
  // 日曆與統計隱藏時不畫（量不到寬度，也沒人看），切過去時由 showView 再畫
  if (document.body.dataset.view === 'calendar') renderCalendarView();
  if (document.body.dataset.view === 'stats') statsView?.render();
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
  $('#btn-try-demo').addEventListener('click', enterDemo);
  $('#btn-demo-exit').addEventListener('click', exitDemo);
  $('#btn-demo').addEventListener('click', () => (store.isDemo() ? exitDemo() : enterDemo()));
  $('#btn-share').addEventListener('click', shareSite);
  $('#btn-backup').addEventListener('click', signIn);
  $('#fab').addEventListener('click', () => openForm(null));

  const logForm = $('#log-form');
  logForm.addEventListener('submit', submitLog);
  logForm.addEventListener('click', (e) => { if (e.target.closest('[data-toggle-time]')) toggleLogTime(); });
  // 「今天的血壓藥」開關：記住今天吃了沒（以天為單位）
  logForm.addEventListener('change', (e) => {
    if (e.target.matches('.meds-seg input') && e.target.checked) setMedsTaken(e.target.value === 'after_meds');
  });
  $('#meds-toggle').addEventListener('change', (e) => {
    setMedsPref({ on: e.target.checked });
    buildForms();
    render();
  });
  $('#meds-name').addEventListener('input', (e) => {
    setMedsPref({ name: e.target.value.trim() });
    buildForms();
  });
  // 定時更新「現在」的時間文字（分頁隱藏時不用）
  setInterval(() => { if (logTimeMode === 'now' && !document.hidden) renderLogTime(); }, 30000);

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
    if (li) openRecord(li.dataset.id);
  };
  $('#today-list').addEventListener('click', openById);
  $('#record-list').addEventListener('click', (e) => {
    if (e.target.closest('[data-more]')) {
      listLimit += LIST_STEP;
      return renderList();
    }
    openById(e);
  });

  statsView = createStatsView($('#view-stats'), { t, getLang, getRecords: store.getRecords, onAiAnalysis: openAiDialog });
  $('#ai-presets').addEventListener('change', updateAiPrompt);
  $('#ai-days').addEventListener('change', updateAiPrompt);
  $('#ai-notes').addEventListener('change', updateAiPrompt);
  $('#ai-open-chatgpt').addEventListener('click', copyAiPrompt);
  $('#ai-open-claude').addEventListener('click', copyAiPrompt);
  $('#ai-copy').addEventListener('click', copyAiPrompt);

  $('.fontsize-seg').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-font-size-choice]');
    if (!btn) return;
    bpackFontSize.set(btn.dataset.fontSizeChoice);
    renderFontSizeChoice();
  });

  $('.theme-seg').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-theme-choice]');
    if (!btn) return;
    bpackTheme.set(btn.dataset.themeChoice);
    renderThemeChoice();
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
  store.onChange(scheduleRender);
}

async function init() {
  applyIcons();
  bindEvents();
  await initI18n();
  $('#lang-select').value = getLang();
  refreshLanguage();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW', e));
  if (CLOUD) {
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
