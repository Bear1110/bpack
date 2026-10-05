// AI 分析：把最近的紀錄整理成精簡文字 + 預設問題，交給使用者自己選的 AI（ChatGPT、Claude…）。
// 本網站不傳送任何資料：是使用者的瀏覽器開新分頁、把文字帶過去（或複製後自己貼上）。
// 紀錄用精簡格式（AI 讀得懂、網址較短），備註保留原文；回覆語言依介面語言指定。

import { localDate, periodOf } from './stats.js';

export const AI_PRESETS = ['overview', 'lifestyle', 'doctor'];
export const AI_DAYS = [14, 30, 90];

const LANG_NAMES = { en: 'English', 'zh-TW': 'Traditional Chinese (Taiwan)' };

const TASKS = {
  overview: 'Summarize my blood pressure: the overall averages, how morning and evening compare, how it changes over the period, how much it varies from day to day, and which days or situations stand out.',
  lifestyle: 'Look at the situation tags and notes (after medication, after exercise, feeling unwell, poor sleep, stress, caffeine) and the time of day, and tell me which of them seem to go with higher or lower readings. Also check whether I am measuring regularly morning and evening, and suggest how to measure more consistently.',
  doctor: 'Prepare a short summary I can show my doctor (period, number of readings, averages overall and by morning/evening, share of readings at or above 140/90, highest readings), followed by a list of questions I should ask at my next appointment.',
};

// 網址參數太長時可能被截斷：超過就改成「複製後自己貼上」
const MAX_URL_QUERY = 7000;

// 精簡格式：每筆一行，例如「2026-10-05 07:12 M 128/82 p70 L tags=after_meds | notes=...」
function entryLine(r, includeNotes) {
  const period = { morning: 'M', afternoon: 'A', evening: 'E' }[periodOf(r.time)] ?? '';
  const parts = [`${r.time.replace('T', ' ')} ${period} ${r.systolic}/${r.diastolic}`];
  if (Number.isFinite(r.pulse)) parts.push(`p${r.pulse}`);
  if (r.arm) parts.push(r.arm === 'left' ? 'L' : 'R');
  if (r.tags?.length) parts.push(`tags=${r.tags.join(',')}`);
  if (includeNotes && r.notes) parts.push(`notes=${String(r.notes).replace(/\s+/g, ' ').trim()}`);
  return parts.join(' ');
}

// 回傳 { prompt, count, from, to }；records 取最近 days 天內的紀錄，依時間由舊到新排列
export function buildAnalysisPrompt(records, { days, preset, lang, includeNotes, medName = '', today = localDate(new Date()) }) {
  const from = localDate(new Date(new Date(`${today}T00:00`).getTime() - (days - 1) * 86400000));
  const recent = records
    .filter((r) => r.time && Number.isFinite(r.systolic) && Number.isFinite(r.diastolic) && r.time.slice(0, 10) >= from && r.time.slice(0, 10) <= today)
    .sort((a, b) => a.time.localeCompare(b.time));
  if (!recent.length) return { prompt: '', count: 0, from, to: today };
  const prompt = `I keep a home blood pressure diary. Below are my ${recent.length} readings from the last ${days} days (${from} to ${today}), oldest first.
Format of each line: date time, period (M = morning, A = afternoon, E = evening), systolic/diastolic in mmHg, p = pulse, L/R = arm, situation tags, notes.
Tags before_meds / after_meds mean the reading was taken before / after that day's blood pressure medication${medName ? ` (${medName})` : ''}; compare the two where possible.

Task: ${TASKS[preset] ?? TASKS.overview}

Please:
- Base everything on these readings. Cite dates or counts as evidence, and say when there is too little data to tell.
- Reference thresholds for home blood pressure: below 130/80 is the usual target; 140/90 or higher is high; 180/120 or higher needs prompt medical attention. Use the higher of the two numbers when categorizing.
- Do not diagnose and do not tell me to change any medication on my own. Point out what is worth discussing with a doctor.
- Reply in ${LANG_NAMES[lang] ?? 'English'}. Keep it concise, with short headings.

Readings:
${recent.map((r) => entryLine(r, includeNotes)).join('\n')}
`;
  return { prompt, count: recent.length, from, to: today };
}

// 開啟 AI 的網址：放得下就帶入提示詞，否則只開首頁（由呼叫端先複製到剪貼簿）
export function aiLinks(prompt) {
  const q = encodeURIComponent(prompt);
  const fits = q.length <= MAX_URL_QUERY;
  return {
    fits,
    chatgpt: fits ? `https://chatgpt.com/?q=${q}` : 'https://chatgpt.com/',
    claude: fits ? `https://claude.ai/new?q=${q}` : 'https://claude.ai/new',
  };
}
