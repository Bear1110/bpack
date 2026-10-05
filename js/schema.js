// 血壓紀錄的 Schema：一次量測一列。
//
// 原則（與 Headack 相同）：
// - 第一欄是唯一 ID，程式以 ID 辨識紀錄，不靠列號（使用者可能手動排序或刪列）。
// - 程式依「標題名稱」對應欄位，不依欄位順序，所以使用者搬動欄位不會壞。
// - 時間存 ISO 本地時間字串（YYYY-MM-DDTHH:mm）。
// - 多選欄位以「;」分隔的固定代碼儲存。

export const SCHEMA_VERSION = 1;

// 固定 sheetId：建立試算表時指定，之後即使使用者改了分頁名稱也找得到
export const RECORDS_SHEET_ID = 0;
export const SETTINGS_SHEET_ID = 1;

export const RECORD_COLUMNS = [
  'id',
  'time',       // 量測時間
  'systolic',   // 收縮壓 mmHg
  'diastolic',  // 舒張壓 mmHg
  'pulse',      // 心跳 bpm（可空）
  'arm',        // 量哪隻手：left / right / 空白
  'tags',       // 情境代碼，以 ; 分隔
  'notes',      // 自由文字
  'created_at',
  'updated_at',
];

export const MULTI_FIELDS = ['tags'];
export const NUMERIC_FIELDS = ['systolic', 'diastolic', 'pulse'];

// 選項代碼（顯示文字在 locales 的 opt.<field>.<code>）
export const OPTIONS = {
  arm: ['left', 'right'],
  // 情境：會影響數值判讀的常見情況
  tags: ['after_meds', 'after_exercise', 'unwell', 'poor_sleep', 'stress', 'after_caffeine'],
};

// 合理的輸入範圍（超出就擋下來，避免打錯一個 0）
export const LIMITS = {
  systolic: [50, 260],
  diastolic: [30, 160],
  pulse: [30, 220],
};

export function newId() {
  return crypto.randomUUID();
}

// ---------- 列 ↔ 物件 ----------

// 物件 → 依標題列順序排出的一列
export function recordToRow(record, headers) {
  return headers.map((h) => {
    const v = record[h];
    if (v == null) return '';
    if (Array.isArray(v)) return v.join(';');
    if (typeof v === 'number') return v;
    return String(v);
  });
}

// 一列 → 物件；ID 為空的列回傳 null（讀取時略過）
export function rowToRecord(row, headers) {
  const r = {};
  headers.forEach((h, i) => {
    if (!h) return;
    r[h] = row[i] ?? '';
  });
  if (!r.id) return null;
  for (const f of MULTI_FIELDS) r[f] = r[f] ? String(r[f]).split(';').filter(Boolean) : [];
  for (const f of NUMERIC_FIELDS) r[f] = r[f] === '' || r[f] == null ? null : Number(r[f]);
  return r;
}
