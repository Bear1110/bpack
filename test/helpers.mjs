// 測試共用：一筆血壓紀錄
export const rec = (time, systolic, diastolic, extra = {}) => ({ id: `${time}-${systolic}`, time, systolic, diastolic, pulse: null, arm: '', tags: [], notes: '', ...extra });
