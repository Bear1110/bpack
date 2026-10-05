<p align="center"><img src="icons/logo.png" width="120" alt=""></p>

<h1 align="center">BPack</h1>

**👉 https://bear1110.github.io/bpack/**

BPack 是免費的血壓日記。量完血壓輸入收縮壓、舒張壓、心跳，就能看每日趨勢、早晚平均，看診時列印摘要給醫師。
紀錄存在**你自己的 Google 雲端硬碟**，網站作者看不到任何人的資料。沒有廣告、沒有追蹤。

> **為什麼叫 BPack？** BP（blood pressure，血壓）加上 ack（acknowledge，確認收到）。血壓要先被「ack」——記下來——才看得出趨勢，和 [Headack](https://github.com/Bear1110/headack) 是同一個想法。

## 功能

- **記錄**：收縮壓、舒張壓、心跳（可不填）。時間預設是現在，按「改時間」可以補登；「更多」裡可以記哪隻手、情境（吃藥後、運動後…）和備註。
- **分級顏色**：依 2017 ACC/AHA 與台灣高血壓學會 2022 指引的家庭血壓標準（目標 <130/80），每筆紀錄標上顏色；180/120 以上會提醒就醫。只是參考，不是診斷。
- **首頁近況**：今天的紀錄、最近 7 天的平均，以及「722」習慣（7 天裡幾天早晚都有量）。
- **統計**：7／30／90 天、1 年、全部；平均、達標比例、每日趨勢折線圖、早上與晚上的比較、各級別分布。
- **看診摘要**：醫師會看的數據一頁列出，可列印或存成 PDF。
- **匯出／匯入**：下載成 JSON 當備份，也能匯回。
- 離線可用、可加到主畫面、淺色／深色、繁體中文與英文。

## 怎麼開始

1. 用手機或電腦打開上面的網址
2. 按「用 Google 登入」
3. 第一次登入時，網站會在你的雲端硬碟建立一份「BPack 血壓紀錄」試算表，之後的紀錄都存在這裡

沒登入也能先記，登入後會自動同步。手機可以「加到主畫面」，用起來就像 App。

## 你的資料

- 紀錄只存在你自己的 Google 試算表，可以直接打開、分享給醫師或刪除
- 網站只能存取它自己建立的那份檔案（`drive.file` 權限），看不到你雲端硬碟的其他內容
- 沒有後端伺服器、沒有廣告、沒有任何分析或追蹤
- 詳見[隱私權政策](https://bear1110.github.io/bpack/privacy.html)

## 開發

純靜態網站（HTML / CSS / JavaScript modules），不需要建置步驟。

```sh
python3 -m http.server 8000   # 本機預覽：http://localhost:8000/
node --test                   # 統計邏輯的測試
node tools/check-locales.mjs  # 多國語系檢查
```

部署前請在 `js/config.js` 填入自己的 Google OAuth 用戶端 ID（網頁應用程式），並在 Cloud Console 把同意畫面切到「正式發布」。

## 注意

本網站僅供個人記錄，顏色與統計不構成醫療診斷，請與醫師討論，請勿自行調整藥物。

---

<a id="english"></a>

## English

BPack is a free blood pressure diary. Enter systolic, diastolic and pulse after each measurement; see daily trends, morning/evening averages, and print a summary for your doctor. Readings are stored in **your own Google Drive** — the site's author never sees anyone's data. No ads, no tracking.

**Why "BPack"?** BP (blood pressure) + ack (acknowledge). A reading has to be acked — written down — before it can show a trend. Same idea as [Headack](https://github.com/Bear1110/headack).

**Features:** quick entry with an adjustable time for backfilling; colour categories following the 2017 ACC/AHA home-BP thresholds (target below 130/80) with a warning at 180/120; last-7-days average and the "722" habit tracker; stats for 7/30/90 days, 1 year or all time with a daily trend chart and morning vs evening comparison; a printable doctor summary; JSON export/import; offline support; install to home screen; light/dark; Traditional Chinese and English.

For personal record-keeping only — not a medical diagnosis. Discuss your numbers with a doctor and never change medication on your own.
