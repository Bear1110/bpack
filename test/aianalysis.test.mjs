// AI 分析提示詞：取最近 N 天、由舊到新、格式正確、沒資料時為空
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAnalysisPrompt, aiLinks } from '../js/aianalysis.js';

const rec = (time, s, d, extra = {}) => ({ id: time, time, systolic: s, diastolic: d, pulse: null, arm: '', tags: [], notes: '', ...extra });

test('只取最近 N 天，依時間由舊到新', () => {
  const records = [
    rec('2026-10-05T21:00', 130, 85),
    rec('2026-10-05T07:00', 120, 80, { pulse: 66, arm: 'left', tags: ['after_meds'], notes: '頭有點暈' }),
    rec('2026-09-01T07:00', 150, 95), // 超過 30 天
  ];
  const { prompt, count, from } = buildAnalysisPrompt(records, { days: 30, preset: 'overview', lang: 'zh-TW', includeNotes: true, today: '2026-10-05' });
  assert.equal(count, 2);
  assert.equal(from, '2026-09-06');
  const lines = prompt.trim().split('\n');
  assert.equal(lines.at(-2), '2026-10-05 07:00 M 120/80 p66 L tags=after_meds notes=頭有點暈');
  assert.equal(lines.at(-1), '2026-10-05 21:00 E 130/85');
  assert.ok(prompt.includes('Traditional Chinese'));
  assert.ok(!prompt.includes('150/95'));
});

test('不含備註時不輸出 notes', () => {
  const { prompt } = buildAnalysisPrompt([rec('2026-10-05T07:00', 120, 80, { notes: 'secret' })], { days: 14, preset: 'doctor', lang: 'en', includeNotes: false, today: '2026-10-05' });
  assert.ok(!prompt.includes('secret'));
  assert.ok(prompt.includes('show my doctor'));
});

test('沒有紀錄：空提示詞', () => {
  assert.equal(buildAnalysisPrompt([], { days: 30, preset: 'overview', lang: 'en', includeNotes: true }).count, 0);
});

test('提示詞太長時不放進網址', () => {
  const short = aiLinks('hello');
  assert.equal(short.fits, true);
  assert.ok(short.chatgpt.includes('q=hello'));
  const long = aiLinks('x'.repeat(8000));
  assert.equal(long.fits, false);
  assert.equal(long.claude, 'https://claude.ai/new');
});
