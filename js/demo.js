// 示範模式的範例資料：以今天為基準往前約 7 個月，固定亂數種子（每次產生的內容相同）。
// 故事：一開始偏高（第 1～2 期高血壓），約 3 個月前開始吃藥後慢慢降到接近達標；偶爾壓力大、喝咖啡、睡不好會飆高，
// 少數幾天忘記量或只量一次。脈搏、手臂、情境都有出現，讓日曆、趨勢、吃藥前後比較、看診摘要都有內容。

import { localDate } from './stats.js';

const DAYS = 210;
const MEDS_START = 95; // 幾天前開始吃藥

function rng(seed) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

const pad = (n) => String(n).padStart(2, '0');
const at = (day, hour, minute) => `${day}T${pad(hour)}:${pad(minute)}`;
const jitter = (rand, spread) => Math.round((rand() - 0.5) * 2 * spread);

export function buildDemoRecords() {
  const rand = rng(20261006);
  const records = [];
  const now = new Date();

  for (let off = DAYS; off >= 0; off--) {
    const d = new Date(now);
    d.setDate(d.getDate() - off);
    const day = localDate(d);
    const onMeds = off <= MEDS_START;

    // 趨勢：吃藥前約 137/86，吃藥後 3 週內慢慢降到約 122/76
    const progress = onMeds ? Math.min(1, (MEDS_START - off) / 21) : 0;
    const baseSys = 137 - 15 * progress;
    const baseDia = 86 - 10 * progress;

    // 早晚各一次；偶爾只量一次或整天沒量（今天只有早上，晚上還沒到）
    const skipDay = off > 0 && rand() < 0.05;
    if (skipDay) continue;
    const slots = [];
    if (rand() > 0.08) slots.push({ hour: 6 + Math.floor(rand() * 3), morning: true });
    if (off > 0 && rand() > 0.12) slots.push({ hour: 20 + Math.floor(rand() * 3), morning: false });
    if (off > 0 && rand() < 0.08) slots.push({ hour: 13 + Math.floor(rand() * 4), morning: false, extra: true });

    for (const slot of slots) {
      const tags = [];
      let sys = baseSys + jitter(rand, 6) + (slot.morning ? 4 : -2); // 早上通常比較高
      let dia = baseDia + jitter(rand, 4) + (slot.morning ? 2 : -1);

      if (onMeds && !slot.extra) tags.push(slot.morning ? 'before_meds' : 'after_meds');
      if (slot.extra) {
        tags.push('after_exercise');
        sys += 12; dia += 3;
      } else if (rand() < 0.07) {
        tags.push('stress'); sys += 14; dia += 6;
      } else if (rand() < 0.06) {
        tags.push('poor_sleep'); sys += 9; dia += 4;
      } else if (rand() < 0.05) {
        tags.push('after_caffeine'); sys += 8; dia += 3;
      } else if (rand() < 0.02) {
        tags.push('unwell'); sys += 6; dia += 2;
      }

      const minute = Math.floor(rand() * 60);
      const time = at(day, slot.hour, minute);
      const pulse = rand() < 0.92 ? Math.round(68 + jitter(rand, 9) + (slot.extra ? 14 : 0)) : null;
      const stamp = new Date(time).toISOString();
      records.push({
        id: `demo-${records.length}`,
        time,
        systolic: Math.round(sys),
        diastolic: Math.round(dia),
        pulse,
        arm: rand() < 0.85 ? 'left' : 'right',
        tags,
        notes: '',
        created_at: stamp,
        updated_at: stamp,
      });
    }
  }
  return records;
}
