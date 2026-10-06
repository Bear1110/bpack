// 主題（淺色／深色）與文字大小：在 <head> 以一般 script 載入，畫面畫出來之前就套用，避免閃一下。
// 偏好存在 localStorage（沒有＝預設值），結果寫在 <html> 的 data 屬性，CSS 依此換色／縮放。
(() => {
  // 一個偏好：只接受 allowed 內的值；設成預設值時移除儲存，其他分頁改了也會跟著套用
  function makePref({ key, allowed, fallback, onApply }) {
    const get = () => {
      try {
        const v = localStorage.getItem(key);
        return allowed.includes(v) ? v : fallback;
      } catch { return fallback; }
    };
    const apply = () => onApply(get());
    addEventListener('storage', (e) => { if (e.key === key) apply(); });
    apply();
    return {
      get,
      apply,
      set(v) {
        try {
          if (allowed.includes(v) && v !== fallback) localStorage.setItem(key, v);
          else localStorage.removeItem(key);
        } catch { /* ignore */ }
        apply();
      },
    };
  }

  // 主題：'light' / 'dark'；沒有＝跟隨系統
  const media = matchMedia('(prefers-color-scheme: dark)');
  const theme = makePref({
    key: 'bp.theme',
    allowed: ['light', 'dark'],
    fallback: 'system',
    onApply: (p) => { document.documentElement.dataset.theme = p === 'system' ? (media.matches ? 'dark' : 'light') : p; },
  });
  media.addEventListener('change', theme.apply); // 跟隨系統時，系統切換就跟著換

  // 文字大小：三個級距，CSS 以 rem 縮放整個版面
  const fontSize = makePref({
    key: 'bp.fontSize',
    allowed: ['standard', 'large', 'xlarge'],
    fallback: 'standard',
    onApply: (v) => { document.documentElement.dataset.fontSize = v; },
  });

  // 給設定頁用
  window.bpackTheme = { get: theme.get, set: theme.set };
  window.bpackFontSize = { get: fontSize.get, set: fontSize.set };
})();
