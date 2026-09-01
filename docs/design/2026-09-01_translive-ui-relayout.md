# TransLive UI 重排版紀錄與第二輪產品化項目

> **日期：**2026-09-01
> **狀態：**第一輪重排版已實作；第二輪項目以 TDD 實作中
> **母文件：**[2026-08-29_translive-formal-ui-proposal.md](./2026-08-29_translive-formal-ui-proposal.md)（資訊架構與設計系統不變，本文件只記錄版面調整與新增操作面）

## 1. 背景

使用者回饋正式 UI 六項版面問題，並要求以「產品化、容易操作」為目標提出未觀察到的問題。處理分兩輪：

- **第一輪（已完成）：**版面重排，不新增功能邏輯；
- **第二輪（本文件追蹤）：**補上產品化缺口——裝置熱插拔、還原可見性、輸出測試、音色頁導引。

## 2. 第一輪重排版（已完成）

| # | 問題 | 處理 |
| --- | --- | --- |
| 1 | 快速設定 Teams／Zoom 佔位過大、未對稱 | 說明文字移入 modal；按鈕併入「會議平台」欄位列（`field-action`），主畫面不再獨佔一列 |
| 2 | Windows 音訊角色說明在麥克風模式佔空間 | 常駐段落刪除，改為 status strip 上的 ⓘ 按鈕（`#audio-role-info`）按需展開（`#role-note`） |
| 3 | RVC 設定混入設定頁 | 新增頂部導覽「音色」頁（`data-view="voice"`），RVC 啟用、設定檔、匯入、錄製訓練、刪除整區遷入 |
| 4 | 設定頁未置中 | `.settings-screen`／`.voice-screen` 以 `max-width: 760px; margin-inline: auto` 置中；設定分帳戶／一般／系統三組 |
| 5 | 翻譯內容字體過大、無法看全部 | 譯文 21–27px→16–20px、hero 25–34px→20–28px；每個字幕區 `max-height`＋細捲軸；新內容自動捲到底，上捲 24px 暫停跟隨 |
| 6 | 裝置欄位值與框重疊 | select 補 data-URI 下拉箭頭、`width:100%`、`text-overflow: ellipsis`（根因：`appearance:none` 未配箭頭與截斷） |

額外同輪完成（產品化觀察）：

1. 音訊路由依流向分組：會議與路由／我說出去（TX）／我聽進來（RX），按模式只顯示相關組；
2. 三行狀態文字（health-row＋兩段 status）合併為單條 status strip，Windows／VoiceMeeter 狀態僅警告時展開（`data-level="ok|warn"`）；
3. `.live-bar` 改 sticky，停止按鈕永遠在畫面內；
4. select 補下拉箭頭（同 #6）；
5. live-footer 新增 A−／A＋ 字幕縮放（`--caption-scale` 0.8–1.4，localStorage 持久化）。

## 3. 第二輪範圍與 TDD seams

每個 slice 一個公開 seam，先紅後綠；不測內部實作。

### Slice A — 裝置熱插拔

- **問題：**耳機／虛擬裝置拔除時無任何提示，使用者只能自己猜。
- **Seam：**`src/device-change-controller.js` 純函數 `decideDeviceChangeReaction({ appState, missingSlots, mode })`。
- **行為：**任何狀態皆觸發重新掃描；ready 時更新 ready-message；live/degraded 且當前模式所需 slot 消失時顯示警告（診斷抽屜可見細節）；其餘狀態靜默。

### Slice B — 停止後還原狀態呈現

- **問題：**「停止後自動還原」是產品承諾，但 stopped 畫面沒有還原結果。
- **Seam：**`view-state.js` 的 `stoppedStatePresentation({ audioDefaultsState, routingState })`。
- **行為：**兩者皆正常 →「原本的 Windows 音訊設定已還原。」；任一失敗／待還原 → 警告句並指向診斷。renderer 需保存最近一次 audio defaults 與 routing state。

### Slice C — 輸出裝置測試音

- **問題：**開始前無法確認「耳機真的會響／虛擬麥克風真的收得到」，這是本產品最高失敗點。
- **Seam：**`src/output-tester.js` 的 `createOutputTester({ contextFactory })`，狀態機 idle→playing→done/error。
- **行為：**虛擬麥克風輸出與耳機輸出欄位各加「測試」小按鈕，播 0.4s 880Hz 提示音到所選 sink（`AudioContext.setSinkId`，與 live 播放同路徑）。未選裝置時按鈕 disabled。

### Slice D — 音色頁空白導引

- **問題：**無音色設定檔時頁面只有 disabled 控制項，使用者不知道從哪開始。
- **Seam：**`view-state.js` 的 `voiceEmptyStateVisible(profileCount)`。
- **行為：**0 個設定檔時顯示引導（說明錄製約 10 分鐘、僅本機處理、指向錄製區），有設定檔時隱藏。

## 4. 已存在、不重做

| 需求 | 現況 |
| --- | --- |
| 每模式保存裝置設定 | `device-recommendations.js` 的 `rememberDeviceLabel` 以 mode＋slot 記錄，`recommendModeDevices` 於切換模式時套用 |
| 翻譯中禁止切換模式／改路由 | 模式切換與路由欄位只在 ready 畫面；`setMode` 僅接受 ready/checking 狀態 |
| 開始前預檢 | 主行程 `preflight` IPC＋ready-message 缺少裝置清單＋status strip 三項健康燈 |
| 逐字稿保存同意 | consent modal 已於首次開始前出現 |

## 5. 延後（有明確觸發條件才做）

- 麥克風即時電平表：等使用者回報「不知道麥克風有沒有收到聲音」再做；
- TX/RX 單通道重試：需要 session 層支援，另行設計；
- 設定頁再拆「隱私與資料」分頁：等隱私相關項目超過 4 項再拆；
- 字幕更多自訂（字體、行距）：A−／A＋ 先觀察使用情況。

## 6. RX 語音路徑改正（2026-09-01 定案）

**根因（現場捕獲證實）：**codex 0.150.0 的 V3 wire 只有 `output_transcript.added`（增量）與 `turn.done`（**整個 turn 的累積全文**，無 itemId／handoff id）。連續兩次 appendSpeech 落在同一上游 turn 時，`turn.done` 回傳合體全文；flat 回音比對要求單段精確相符 → 合體文字被當新翻譯重切重播 → 自我回音迴圈（現場：每 ~5.4s 一循環，pacing-61/63/65… 同指紋重派）。

**決策（方案 A）：**RX 語音與 TX 對稱——翻譯語音只由模型原生音訊輸出，**移除 appendSpeech 重講路徑**（協議無法提供回音關聯 ID，任何回注設計都不可靠）。pacer 保留為字幕節奏器（dispatch 只推進字幕，不發 RPC）。迴圈由構造消除。

**尾句未播：**改由 GPT-Live init prompt 要求模型講完每句到最後（RX prompt 新增 "never leave the final part unspoken"）；停止時仍以有界 drain 完成字幕推進，未播部分維持回報。

**移除的舊測試：**append RPC ack 相關的三個 echo 測試（已無此行為）；其餘 pacing 測試遷移為「零 appendSpeech＋字幕推進」契約。
