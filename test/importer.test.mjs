// 匯入解析：AI 回覆、匯出檔、各種寬鬆格式
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseImport, buildExport, buildPrompt } from '../js/importer.js';

test('AI 回覆：```json 圍欄與前後說明都能解析', () => {
  const text = `Here you go:\n\`\`\`json\n{"format":"bpack","version":1,"records":[{"time":"2026-09-30T07:30","systolic":128,"diastolic":82,"pulse":70,"arm":"left","tags":["after_meds"],"notes":""}]}\n\`\`\`\nLet me know!`;
  const r = parseImport(text, []);
  assert.equal(r.records.length, 1);
  assert.deepEqual({ ...r.records[0], id: 'x' }, { id: 'x', time: '2026-09-30T07:30', systolic: 128, diastolic: 82, pulse: 70, arm: 'left', tags: ['after_meds'], notes: '' });
});

test('只有日期 → 補 12:00；中文選項名稱 → 代碼；高低壓寫反會對調', () => {
  const r = parseImport(JSON.stringify([{ date: '2026/9/30', systolic: 80, diastolic: 125, pulse: '', arm: '右手', tags: '運動後, 不舒服' }]), []);
  const x = r.records[0];
  assert.equal(x.time, '2026-09-30T12:00');
  assert.equal(x.systolic, 125);
  assert.equal(x.diastolic, 80);
  assert.equal(x.pulse, null);
  assert.equal(x.arm, 'right');
  assert.deepEqual(x.tags, ['after_exercise', 'unwell']);
});

test('缺時間、數值不合理的列算錯誤；重複的略過', () => {
  const existing = [{ id: 'a', time: '2026-09-30T07:30', systolic: 128, diastolic: 82 }];
  const r = parseImport(JSON.stringify({ records: [
    { time: '2026-09-30T07:30', systolic: 128, diastolic: 82 }, // 與既有重複
    { id: 'a', time: '2026-10-01T07:30', systolic: 120, diastolic: 80 }, // 同 ID 重複
    { systolic: 120, diastolic: 80 }, // 缺時間
    { time: '2026-10-02T07:30', systolic: 400, diastolic: 80 }, // 超出範圍
    { time: '2026-10-02T07:30', systolic: 120, diastolic: 120 }, // 相等
    { time: '2026-10-03T21:00', systolic: 135, diastolic: 85 },
  ] }), existing);
  assert.equal(r.records.length, 1);
  assert.equal(r.duplicates, 2);
  assert.equal(r.errors.length, 3);
});

test('匯出再匯入：往返一致', () => {
  const records = [{ id: 'r1', time: '2026-10-03T21:00', systolic: 135, diastolic: 85, pulse: null, arm: '', tags: [], notes: '', created_at: 'c', updated_at: 'u' }];
  const out = buildExport(records);
  assert.equal(out.format, 'bpack');
  assert.deepEqual(out.records[0], { id: 'r1', time: '2026-10-03T21:00', systolic: 135, diastolic: 85, created_at: 'c', updated_at: 'u' });
  const back = parseImport(JSON.stringify(out), []);
  assert.equal(back.records[0].id, 'r1');
  assert.equal(back.records[0].pulse, null);
});

test('垃圾文字：丟出錯誤', () => {
  assert.throws(() => parseImport('hello there', []));
});

test('提示詞包含格式與所有情境代碼', () => {
  const p = buildPrompt();
  for (const c of ['after_meds', 'after_exercise', 'unwell', 'poor_sleep', 'stress', 'after_caffeine']) assert.ok(p.includes(c));
  assert.ok(p.includes('"format": "bpack"'));
});
