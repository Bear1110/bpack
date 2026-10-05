// 匯入：使用者把自己在別處的血壓資料（筆記本的照片、其他 App、血壓計的輸出）交給任一 AI，
// 搭配本網站產生的提示詞轉成 JSON，再貼回來匯入；也接受本網站匯出的 JSON 檔。
//
// 本網站不會把使用者的資料送給任何 AI：提示詞裡只有格式說明，資料由使用者自己貼到 AI。
// 解析刻意寬鬆：允許 ```json 圍欄、前後說明文字、各語言的選項名稱。

import { OPTIONS, LIMITS, newId } from './schema.js';
import en from './locales/en.js';
import zhTW from './locales/zh-TW.js';

export const IMPORT_FORMAT = 'bpack';
export const IMPORT_VERSION = 1;

const ALL_LOCALES = [en, zhTW];

// ---------- 提示詞 ----------

// 選項只列英文名稱：AI 能自行對應各語言的寫法，且網址參數不會因編碼中文而過長
export function buildPrompt() {
  const list = (prefix, codes) => codes.map((c) => `  - ${c}: ${en[`${prefix}.${c}`]}`).join('\n');
  return `You are helping me import my blood pressure history into a blood pressure diary app.
After this message I will paste my readings (notes, a table, or text copied from another app). Convert every reading into JSON in exactly this format, and reply with ONLY the JSON in a single code block:

{
  "format": "${IMPORT_FORMAT}",
  "version": ${IMPORT_VERSION},
  "records": [
    { "time": "2026-09-30T07:30", "systolic": 128, "diastolic": 82, "pulse": 70, "arm": "left", "tags": ["after_meds"], "notes": "" }
  ]
}

Rules:
- One record per measurement. If two readings were taken a minute apart, keep both.
- "time" is required, in local time "YYYY-MM-DDTHH:mm". If my notes only say morning / evening, use 07:00 / 21:00. If only the date is known, use "YYYY-MM-DD". If the year is not stated, ask me instead of guessing.
- "systolic" and "diastolic" are integers in mmHg (the higher number is systolic). Skip readings where either is missing.
- "pulse": integer beats per minute, or null if not recorded.
- "arm": "left", "right", or "" if not stated.
- "tags": list of codes that apply, or []:
${list('opt.tags', OPTIONS.tags)}
- "notes": anything else worth keeping, in the original language of my notes.
- Do not invent data that is not in my notes.

My readings:
`;
}

// 直接開啟 AI 並帶入提示詞（只含格式說明，不含使用者資料）
export function aiLinks(prompt) {
  const q = encodeURIComponent(prompt);
  return {
    chatgpt: `https://chatgpt.com/?q=${q}`,
    claude: `https://claude.ai/new?q=${q}`,
  };
}

// ---------- 解析 ----------

// 從貼上的文字中取出 JSON（容許 ``` 圍欄與前後說明文字）
function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced ? fenced[1] : text).trim();
  try { return JSON.parse(body); } catch { /* 往下嘗試 */ }
  const start = body.search(/[[{]/);
  const end = Math.max(body.lastIndexOf('}'), body.lastIndexOf(']'));
  if (start < 0 || end <= start) throw new Error('no_json');
  return JSON.parse(body.slice(start, end + 1));
}

const norm = (s) => String(s ?? '').trim().toLowerCase();
const aliases = (label) => [label, ...label.split(/[（）()、／/]/)].map(norm).filter((s) => s.length > 1);

// 代碼或任一語言的顯示名稱 → 代碼
function buildLookup(prefix, codes) {
  const map = new Map();
  for (const c of codes) map.set(norm(c), c);
  for (const c of codes) {
    for (const loc of ALL_LOCALES) {
      const label = loc[`${prefix}.${c}`];
      if (typeof label !== 'string') continue;
      for (const a of aliases(label)) if (!map.has(a)) map.set(a, c);
    }
  }
  return map;
}

const lookups = {
  arm: buildLookup('opt.arm', OPTIONS.arm),
  tags: buildLookup('opt.tags', OPTIONS.tags),
};

function toList(v) {
  if (Array.isArray(v)) return v;
  if (v == null || v === '') return [];
  return String(v).split(/[,;、，]/);
}

// 時間 → "YYYY-MM-DDTHH:mm"。只有日期時補 12:00（算「下午／其他」，不會混進早晚平均）
function normTime(v) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  const m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[T\s](\d{1,2}):(\d{2}))?/);
  if (!m) return null;
  const p = (n) => String(n).padStart(2, '0');
  const [, y, mo, d, h = '12', mi = '0'] = m;
  if (+mo < 1 || +mo > 12 || +d < 1 || +d > 31 || +h > 23 || +mi > 59) return null;
  return `${y}-${p(mo)}-${p(d)}T${p(h)}:${p(mi)}`;
}

// 整數且在合理範圍內；否則 null
function normNumber(v, [min, max]) {
  if (v === '' || v == null) return null;
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}

function normalize(raw) {
  if (!raw || typeof raw !== 'object') return { error: 'not_object' };
  const time = normTime(raw.time ?? raw.date ?? raw.start);
  if (!time) return { error: 'bad_time' };
  let systolic = normNumber(raw.systolic ?? raw.sys, LIMITS.systolic);
  let diastolic = normNumber(raw.diastolic ?? raw.dia, LIMITS.diastolic);
  if (systolic == null || diastolic == null) return { error: 'bad_values' };
  if (systolic < diastolic) [systolic, diastolic] = [diastolic, systolic]; // 寫反了就對調
  if (systolic === diastolic) return { error: 'bad_values' };
  return {
    record: {
      id: typeof raw.id === 'string' && raw.id ? raw.id : newId(),
      time,
      systolic,
      diastolic,
      pulse: normNumber(raw.pulse, LIMITS.pulse),
      arm: lookups.arm.get(norm(raw.arm)) ?? '',
      tags: [...new Set(toList(raw.tags).map((x) => lookups.tags.get(norm(x))).filter(Boolean))],
      notes: String(raw.notes ?? '').trim(),
    },
  };
}

// 回傳 { records, duplicates, errors: [{ index, error }] }
// 與既有紀錄（或同批）時間、收縮壓、舒張壓都相同者視為重複；同一個 ID 也算重複。
export function parseImport(text, existing) {
  const data = extractJson(text);
  const rows = Array.isArray(data) ? data : data?.records;
  if (!Array.isArray(rows)) throw new Error('no_records');

  const key = (r) => `${r.time}|${r.systolic}|${r.diastolic}`;
  const seen = new Set(existing.map(key));
  const ids = new Set(existing.map((r) => r.id));
  const records = [];
  const errors = [];
  let duplicates = 0;
  rows.forEach((raw, index) => {
    const { record, error } = normalize(raw);
    if (error) return errors.push({ index, error });
    if (seen.has(key(record)) || ids.has(record.id)) return duplicates++;
    seen.add(key(record));
    ids.add(record.id);
    records.push(record);
  });
  records.sort((a, b) => a.time.localeCompare(b.time));
  return { records, duplicates, errors };
}

// ---------- 匯出 ----------

// 匯出格式與匯入格式相同，可直接匯回本網站，或交給 AI / 其他工具使用
const EXPORT_FIELDS = ['id', 'time', 'systolic', 'diastolic', 'pulse', 'arm', 'tags', 'notes', 'created_at', 'updated_at'];
export function buildExport(records) {
  const list = [...records]
    .sort((a, b) => (a.time || '').localeCompare(b.time || ''))
    .map((r) => {
      const out = {};
      for (const f of EXPORT_FIELDS) {
        const v = r[f];
        if (v == null || v === '') continue;
        if (Array.isArray(v) && !v.length) continue;
        out[f] = v;
      }
      return out;
    });
  return {
    format: IMPORT_FORMAT,
    version: IMPORT_VERSION,
    exported_at: new Date().toISOString(),
    records: list,
  };
}
