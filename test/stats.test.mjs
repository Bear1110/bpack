// 統計邏輯的測試：分級門檻、時段、平均、區間、722 習慣。
// 執行：node --test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classify, onTarget, periodOf, average, groupByDay, dailyAverages, inRange, summarize, sevenTwoTwo, localDate,
} from '../js/stats.js';

const rec = (time, systolic, diastolic, pulse = null, extra = {}) => ({ id: `${time}-${systolic}`, time, systolic, diastolic, pulse: typeof pulse === 'object' && pulse ? null : pulse, tags: [], ...(typeof pulse === 'object' && pulse ? pulse : extra) });

// ---------- 分級 ----------

test('分級門檻（以較高的級別為準）', () => {
  assert.equal(classify(110, 70), 'normal');
  assert.equal(classify(119, 79), 'normal');
  assert.equal(classify(120, 79), 'elevated');
  assert.equal(classify(129, 79), 'elevated');
  assert.equal(classify(130, 79), 'stage1');
  assert.equal(classify(110, 80), 'stage1'); // 只有舒張壓達到也算
  assert.equal(classify(139, 89), 'stage1');
  assert.equal(classify(140, 85), 'stage2');
  assert.equal(classify(125, 90), 'stage2');
  assert.equal(classify(180, 70), 'crisis');
  assert.equal(classify(150, 120), 'crisis');
});

test('偏低：收縮壓 <90 或舒張壓 <60', () => {
  assert.equal(classify(89, 70), 'low');
  assert.equal(classify(100, 59), 'low');
  assert.equal(classify(90, 60), 'normal');
  assert.equal(classify(125, 55), 'elevated'); // 偏高優先於偏低
});

test('沒有數字就沒有分級', () => {
  assert.equal(classify(null, 80), null);
  assert.equal(classify('abc', 80), null);
});

test('達標 <130/80', () => {
  assert.equal(onTarget(129, 79), true);
  assert.equal(onTarget(130, 79), false);
  assert.equal(onTarget(129, 80), false);
  assert.equal(onTarget(null, 80), false);
});

// ---------- 時段 ----------

test('時段：早上 04–11、下午 12–17、晚上 18–03', () => {
  assert.equal(periodOf('2026-10-05T04:00'), 'morning');
  assert.equal(periodOf('2026-10-05T11:59'), 'morning');
  assert.equal(periodOf('2026-10-05T12:00'), 'afternoon');
  assert.equal(periodOf('2026-10-05T17:59'), 'afternoon');
  assert.equal(periodOf('2026-10-05T18:00'), 'evening');
  assert.equal(periodOf('2026-10-05T23:30'), 'evening');
  assert.equal(periodOf('2026-10-05T03:59'), 'evening');
  assert.equal(periodOf(''), null);
});

// ---------- 平均 ----------

test('平均四捨五入到整數，心跳只算有填的', () => {
  const a = average([rec('2026-10-05T08:00', 121, 81, 70), rec('2026-10-05T20:00', 124, 78), rec('2026-10-06T08:00', 130, 82, 75)]);
  assert.equal(a.n, 3);
  assert.equal(a.systolic, 125);
  assert.equal(a.diastolic, 80);
  assert.equal(a.pulse, 73); // (70 + 75) / 2 = 72.5 → 73
  assert.equal(a.pulseN, 2);
});

test('沒有紀錄：平均為 null', () => {
  assert.deepEqual(average([]), { n: 0, systolic: null, diastolic: null, pulse: null, pulseN: 0 });
});

test('缺收縮壓或舒張壓的紀錄不計入平均', () => {
  const a = average([rec('2026-10-05T08:00', 120, 80), { id: 'x', time: '2026-10-05T09:00', systolic: 200, diastolic: null }]);
  assert.equal(a.n, 1);
  assert.equal(a.systolic, 120);
});

test('依日期分組並排序；每日平均', () => {
  const records = [rec('2026-10-06T08:00', 130, 80), rec('2026-10-05T08:00', 120, 80), rec('2026-10-05T20:00', 124, 84)];
  const g = groupByDay(records);
  assert.deepEqual([...g.keys()], ['2026-10-05', '2026-10-06']);
  assert.equal(g.get('2026-10-05').length, 2);
  const d = dailyAverages(records);
  assert.deepEqual(d.map((x) => [x.day, x.systolic, x.diastolic, x.n]), [['2026-10-05', 122, 82, 2], ['2026-10-06', 130, 80, 1]]);
});

// ---------- 區間 ----------

test('inRange 含頭尾兩天', () => {
  const records = [rec('2026-09-30T23:59', 120, 80), rec('2026-10-01T00:00', 121, 80), rec('2026-10-07T23:59', 122, 80), rec('2026-10-08T00:00', 123, 80)];
  assert.deepEqual(inRange(records, '2026-10-01', '2026-10-07').map((r) => r.systolic), [121, 122]);
});

test('summarize：筆數、天數、早晚平均、級別分布、達標、最高最低', () => {
  const records = [
    rec('2026-10-05T07:00', 118, 76, 68),
    rec('2026-10-05T21:00', 135, 85, 72),
    rec('2026-10-06T07:30', 128, 79),
    rec('2026-10-06T14:00', 142, 91),
  ];
  const s = summarize(records);
  assert.equal(s.n, 4);
  assert.equal(s.days, 2);
  assert.equal(s.avg.systolic, 131);
  assert.equal(s.byPeriod.morning.n, 2);
  assert.equal(s.byPeriod.morning.systolic, 123);
  assert.equal(s.byPeriod.evening.n, 1);
  assert.equal(s.byPeriod.evening.systolic, 135);
  assert.equal(s.byPeriod.afternoon.n, 1);
  assert.deepEqual(s.categories, { low: 0, normal: 1, elevated: 1, stage1: 1, stage2: 1, crisis: 0 });
  assert.equal(s.onTarget, 2);
  assert.equal(s.highest.systolic, 142);
  assert.equal(s.lowest.systolic, 118);
});

test('summarize 空集合不會壞', () => {
  const s = summarize([]);
  assert.equal(s.n, 0);
  assert.equal(s.avg.systolic, null);
  assert.equal(s.highest, null);
});

// ---------- 722 ----------

test('722：最近 7 天裡早晚都有量的天數', () => {
  const today = '2026-10-07';
  const records = [
    rec('2026-10-07T07:00', 120, 80), rec('2026-10-07T21:00', 120, 80), // 今天早晚
    rec('2026-10-06T07:00', 120, 80), // 只有早上
    rec('2026-10-01T07:00', 120, 80), rec('2026-10-01T22:00', 120, 80), // 7 天內的最後一天
    rec('2026-09-30T07:00', 120, 80), rec('2026-09-30T22:00', 120, 80), // 第 8 天，不算
  ];
  assert.deepEqual(sevenTwoTwo(records, today), { days: 7, any: 3, both: 2 });
});

test('localDate 補零', () => {
  assert.equal(localDate(new Date(2026, 0, 5)), '2026-01-05');
});

// ---------- 日曆：每天的早晚半圓 ----------

import { dayHalves } from '../js/stats.js';

test('dayHalves：早晚各自平均並分級，下午算成小點', () => {
  const m = dayHalves([
    rec('2026-10-05T07:00', 118, 76), rec('2026-10-05T07:03', 122, 80), // 早上兩次 → 120/78 偏高
    rec('2026-10-05T14:00', 150, 95), // 下午 → other
    rec('2026-10-06T21:00', 142, 91), // 只有晚上
  ]);
  const d5 = m.get('2026-10-05');
  assert.deepEqual(d5.morning, { systolic: 120, diastolic: 78, n: 2, cat: 'elevated' });
  assert.equal(d5.evening, null);
  assert.equal(d5.other, 1);
  const d6 = m.get('2026-10-06');
  assert.equal(d6.morning, null);
  assert.equal(d6.evening.cat, 'stage2');
  assert.equal(d6.other, 0);
});

// ---------- 吃藥前／後 ----------

import { splitByMeds } from '../js/stats.js';

test('dayHalves 標出當天有吃藥；splitByMeds 分開平均', () => {
  const records = [
    rec('2026-10-05T07:00', 138, 88, { tags: ['before_meds'] }),
    rec('2026-10-05T21:00', 124, 80, { tags: ['after_meds'] }),
    rec('2026-10-06T07:00', 136, 86, { tags: ['before_meds'] }),
    rec('2026-10-07T07:00', 130, 84), // 沒標記
  ];
  const halves = dayHalves(records);
  assert.equal(halves.get('2026-10-05').meds, true);
  assert.equal(halves.get('2026-10-06').meds, false);
  const m = splitByMeds(records);
  assert.equal(m.any, true);
  assert.deepEqual([m.before.systolic, m.before.diastolic, m.before.n], [137, 87, 2]);
  assert.deepEqual([m.after.systolic, m.after.n], [124, 1]);
  assert.equal(splitByMeds([rec('2026-10-07T07:00', 130, 84)]).any, false);
});
