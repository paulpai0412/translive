# TransLive 正式版 UI 設計方案

> **階段：**UI 方向確認（尚未開始實作）
>
> **語言：**繁體中文為主；英文作為模式副標、技術名詞與錯誤碼輔助
>
> **範圍：**Windows 桌面 App，涵蓋登入、模式設定、音訊設定、即時字幕、狀態、診斷、紀錄與錯誤處理

## 1. 新增需求

正式版不限制 Zoom／Teams。只要 Windows 應用程式的音訊可路由至 VoiceMeeter／VB‑CABLE，即可使用 TransLive。

新增三種操作模式：

| 模式 | 啟動通道 | 主要用途 | 顯示重點 |
| --- | --- | --- | --- |
| 雙向會議 `Meeting` | TX＋RX | Teams、Zoom、Meet、Discord、Webex | 雙向狀態、雙字幕區、兩個 mute |
| 媒體翻譯 `Media` | RX only | YouTube、VLC、Podcast、串流內容 | 大型目標字幕、媒體來源、耳機輸出 |
| 麥克風翻譯 `Microphone` | TX only | 遊戲語音、直播、語音輸入 | 麥克風電平、對方將聽到的譯文、虛擬 Mic |

共通需求：

- ChatGPT／Codex OAuth 登入與登出；
- GPT‑Live entitlement、版本與 session 狀態；
- 來源音訊、目標語言與音色；
- VoiceMeeter／VB‑CABLE 路由預檢；
- 來源字幕與目標字幕；
- 即時狀態、mute、停止與錯誤復原；
- 延遲、網路、音訊與裝置診斷；
- 本機逐字稿、會議摘要及刪除；
- 置頂迷你字幕窗；
- 繁體中文優先、英文輔助；
- 不顯示沒有實際資料的信心分數或假指標。

## 2. Design Read

```yaml
Artifact: Windows 桌面即時翻譯操作工具
Audience: 非技術使用者、跨語言會議參與者、影片／Podcast 觀眾、直播與遊戲語音使用者
Visual language: 安靜、精準、具 Windows 工具感的 restrained operational UI
Mode: Redesign · Overhaul（保留技術契約，重做資訊架構與視覺）
Visual variance: 3/10
Motion intensity: 2/10
Information density: 6/10
Asset dependence: 1/10
Brand fidelity: 4/10
```

具體影響：

- 低 variance：採穩定網格、單一主要任務區，不做 bento 或浮誇卡片；
- 低 motion：只動畫狀態切換、抽屜與字幕更新，120–180ms；
- 中高 density：Live 畫面可同時看字幕、通道狀態與必要控制，但診斷採漸進揭露；
- 低 asset dependence：產品由資訊架構、字幕和狀態承載，不需要插圖；
- 新品牌階段：建立 TransLive 自有系統，但保持 Windows 操作習慣。

### 四個定位問題

- **Narrative role：**控制與理解，不是行銷展示；使用者應在 3 秒內知道「現在是否在翻譯、翻譯哪裡、聲音送去哪裡」。
- **Viewing distance：**一般筆電 50–80cm；主字幕 22–28px，操作文字 14–16px。
- **Visual temperature：**安靜、可信、低焦慮；Live 有明確但不刺眼的綠色狀態。
- **Capacity check：**一個 viewport 最多顯示兩條通道、四行主要字幕、一列關鍵控制；其他內容移入抽屜。

## 3. 設計系統提案

### 3.1 設計方向

名稱：**Quiet Control / 安靜控制台**

- 以 Windows 11 Fluent 的清晰層級為基礎，但減少半透明、陰影與裝飾；
- 以文字、間距和細分隔線建立層級，不將每段資訊做成卡片；
- 只有可選擇、可展開或有獨立狀態的區塊才使用容器。

### 3.2 色彩

| Role | Light | Dark | 用途 |
| --- | --- | --- | --- |
| Background | `#F6F7F9` | `#111318` | App 背景 |
| Surface | `#FFFFFF` | `#191C23` | 主要工作區、抽屜 |
| Text | `#17191D` | `#F3F4F6` | 主文字 |
| Muted | `#667085` | `#9AA3B2` | 來源字幕、說明 |
| Border | `#E3E6EA` | `#2C313B` | 分隔與輸入框 |
| Primary | `#2F6FED` | `#6EA1FF` | Start、選取狀態 |
| Live | `#147D64` | `#57C7A5` | 正常翻譯 |
| Warning | `#A96916` | `#E2A94B` | Degraded、裝置警告 |
| Danger | `#B9383E` | `#F07178` | Stop、Blocked |

控制規則：

- 一個畫面最多使用 Primary、Live、Warning、Danger 四個語意色；
- 不使用紫粉漸層、霓虹光或大面積狀態色；
- 顏色不單獨承載狀態，必須同時顯示文字與圖示。

### 3.3 字體與尺寸

- UI：`Segoe UI Variable`；繁中 fallback `Noto Sans TC`；
- 診斷值／錯誤碼：`Cascadia Mono`；
- 主字幕：22–28px／600；
- 來源字幕：15–17px／400；
- 一般 UI：14–16px；
- 狀態與技術資訊：12–13px。

使用系統字體是刻意選擇：正式 Windows 工具需降低學習成本與渲染差異，而非建立行銷展示字體。

### 3.4 空間、形狀與動態

- 4px 基準；常用間距 8／12／16／24／32px；
- 輸入與按鈕 radius 8px；主要容器 12px；status chip 才使用 pill；
- 主要依賴 border，只有 modal／drawer 使用單層陰影；
- hover／focus 120ms，panel 180ms；
- 遵守 `prefers-reduced-motion`；字幕不使用滑入、彈跳或打字機效果。

## 4. 資訊架構

```text
TransLive
├─ 即時翻譯
│  ├─ Ready／Setup
│  ├─ Connecting
│  ├─ Live
│  ├─ Degraded／Disconnected
│  └─ Stopped
├─ 紀錄
│  ├─ 逐字稿
│  ├─ 摘要
│  └─ 刪除／開啟資料夾
├─ 設定
│  ├─ 帳戶與 ChatGPT OAuth
│  ├─ 一般與語言
│  ├─ 音訊與虛擬裝置
│  ├─ 隱私與儲存
│  ├─ 快捷鍵
│  └─ 開發者設定
└─ 診斷抽屜
   ├─ 快速健康檢查
   ├─ TX／RX 指標
   ├─ 版本與 session
   └─ 匯出遮罩診斷包
```

桌面導覽採頂部三個文字入口，不使用永久大型側欄：

```text
[TransLive]   即時翻譯   紀錄   設定            [ChatGPT 已連線] [⋯]
```

診斷屬當前 session 的輔助資訊，由右側抽屜開啟，不占主導覽位置。

## 5. 首次使用與 OAuth

### 5.1 首次設定流程

共四步，完成後不再重複顯示：

1. **連接 ChatGPT**：啟動官方 Codex OAuth 系統瀏覽器流程；
2. **選擇使用方式**：雙向會議／媒體翻譯／麥克風翻譯；
3. **語言與聲音**：只呈現目前 runtime 真正支援的選項；
4. **音訊設定**：選擇實體裝置、VoiceMeeter／VB‑CABLE，完成測試音與路由預檢。

### 5.2 OAuth 畫面

```text
┌──────────────────────────────────────────────────────────┐
│ TransLive                                                │
│                                                          │
│ 連接 ChatGPT                                             │
│ Connect ChatGPT                                          │
│                                                          │
│ 使用系統瀏覽器完成 OpenAI／ChatGPT 登入。                 │
│ TransLive 不會讀取或保存你的 OAuth token。                │
│                                                          │
│ [ 連接 ChatGPT ]                                         │
│                                                          │
│ ○ 尚未連線                                               │
└──────────────────────────────────────────────────────────┘
```

狀態：

- 尚未登入：顯示主要登入按鈕；
- 等待瀏覽器：spinner＋「等待瀏覽器確認」＋取消；
- 已登入：顯示 `ChatGPT 已連線 / Connected`，不顯示 token；
- 登入失效：顯示重新登入，不讓使用者誤以為是音訊錯誤。

## 6. Ready 主畫面

```text
┌──────────────────────────────────────────────────────────────────────┐
│ TransLive   即時翻譯   紀錄   設定              ● ChatGPT 已連線     │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│ 使用模式                                                             │
│ [ 雙向會議 Meeting ] [ 媒體翻譯 Media ] [ 麥克風翻譯 Microphone ]   │
│                                                                      │
│ 語言                                                                 │
│ 我說：繁中 → 英文             我聽：自動來源 → 繁中                  │
│                                                                      │
│ 音訊                                                                 │
│ Poly BT600 Mic  →  VoiceMeeter AUX / B2                              │
│ VoiceMeeter Input / B1  →  Poly BT600                                │
│                                                                      │
│ ● ChatGPT   ● GPT-Live   ● 音訊裝置   ● 路由測試                     │
│                                                                      │
│                          [ 開始翻譯 ]                                 │
│                          Start translating                           │
└──────────────────────────────────────────────────────────────────────┘
```

設計原則：

- Ready 畫面只有一個主要 CTA；
- 沒有問題時，健康檢查只顯示一行；
- 有問題時才展開對應設定，不一次展示所有進階欄位；
- 裝置名稱使用人類可辨識名稱，GUID 只在診斷抽屜顯示 hash。

## 7. 模式對應 UI

### 7.1 雙向會議

Ready 顯示：

- 平台 preset：Teams／Zoom／Meet／Discord／Custom；
- 實體 Mic、虛擬 Mic、會議 Speaker Bus、耳機；
- 我說的目標語言；
- 我聽的目標語言；
- TX／RX voice；
- 雙向路由測試。

Live 顯示兩條通道：

```text
┌────────────────────────────┬─────────────────────────────┐
│ 我 → 對方                  │ 對方 → 我                   │
│ TX  ● Live   [靜音]        │ RX  ● Live   [靜音]         │
│                            │                              │
│ 我說                       │ 對方說                       │
│ 我們預計第三季開始量產     │ Could you confirm…          │
│                            │                              │
│ 對方聽到                   │ 我聽到                       │
│ We expect to begin…        │ 可以確認一下…               │
└────────────────────────────┴─────────────────────────────┘
```

### 7.2 媒體翻譯

Ready 只顯示：

- 音訊來源說明／來源 Bus；
- 來源語言：自動偵測；
- 目標語言；
- 耳機與 voice；
- 不要求 Mic 或 TX virtual output。

Live 使用單欄字幕畫面：

```text
┌──────────────────────────────────────────────────────────┐
│ 媒體翻譯 ● Live     YouTube／瀏覽器      [停止]          │
│                                                          │
│ 原文 Source                                              │
│ We expect to begin mass production…                      │
│                                                          │
│ 繁中 Translation                                         │
│ 我們預計在第三季開始正式量產……                           │
│                                                          │
│ 來源：VoiceMeeter B1   RTT 138ms   [診斷]                │
└──────────────────────────────────────────────────────────┘
```

### 7.3 麥克風翻譯

Ready 只顯示：

- 實體 Mic；
- 來源／目標語言；
- 目標 voice；
- 虛擬 Mic；
- 可選的本地監聽。

Live 強調「對方將聽到」：

```text
┌──────────────────────────────────────────────────────────┐
│ 麥克風翻譯 ● Live                         [Mic 靜音]      │
│                                                          │
│ 麥克風  ▂▄▆█▃                                            │
│                                                          │
│ 我說：我們正在測試即時翻譯。                             │
│ 對方將聽到：We are testing realtime translation.         │
│                                                          │
│ 輸出：Voicemeeter B2                         [停止]       │
└──────────────────────────────────────────────────────────┘
```

## 8. Live 共通狀態

Live 時頂部變為固定狀態列：

```text
● 翻譯中 Live     00:18:42     雲端傳輸中     逐字稿保存中     [停止]
```

主字幕規則：

- 來源字幕較小、Muted 色；
- 目標字幕較大、主文字色；
- partial delta 使用 70% opacity，final 轉為完整不透明；
- 不用跳動動畫；
- 目前發言固定在視窗底部，歷史可向上捲動；
- 顯示 `我／對方／媒體`，不偽造 speaker identity；
- 名稱、數字、術語以原字保留時，使用同一字體，不加彩色 pill。

Live 控制只保留：

- TX／RX mute（依模式）；
- 翻譯音量；
- 迷你字幕；
- 診斷；
- Stop。

語言、裝置、voice 在 Live 中鎖定，避免 session 重建造成未說明的中斷。

## 9. 不同狀態的資訊對應

| App 狀態 | 主畫面 | 允許操作 | 不顯示 |
| --- | --- | --- | --- |
| Logged out | OAuth 說明與登入 | 登入、離開 | 模式與 Start |
| Setup required | 缺少項目 checklist | 補設定、測試裝置 | 即時字幕 |
| Ready | 模式摘要、語言、路由、Start | 修改設定、Start | 詳細 metrics |
| Connecting | 連線步驟與取消 | 取消 | 舊字幕、設定欄位 |
| Live | 字幕、通道狀態、mute、Stop | 即時控制 | 可編輯語言與裝置 |
| Degraded | 正常通道＋黃色問題列 | 停止、重試故障通道 | 無關診斷細節 |
| Disconnected | 中斷原因與重新開始 | 重新建立 session | 假 Live 狀態 |
| Blocked | 具體阻擋原因 | 重新登入／修裝置／匯出診斷 | Start |
| Stopped | 最後字幕、保存位置、摘要 CTA | 產生摘要、重新開始 | Live 控制 |

### Connecting 畫面

```text
正在建立翻譯連線…

✓ ChatGPT 登入
✓ Codex runtime 0.150.x
● 建立 TX session
○ 建立 RX session
○ 套用音訊路由

[取消]
```

禁止只顯示無意義 spinner；每一步必須對應真實狀態。

### Degraded／錯誤

```text
RX 已中斷，TX 仍正常運作。
對方仍能聽到你的英文翻譯，但你暫時聽不到繁中翻譯。

[重新建立 RX] [停止全部] [開啟診斷]
```

錯誤訊息結構：

1. 使用者影響；
2. 可執行的修復動作；
3. 技術錯誤碼（英文／monospace，預設折疊）。

## 10. 診斷抽屜

### 基本層

```text
診斷 Diagnostics

帳戶       ● ChatGPT 已連線
模型       ● gpt-live-1-codex
TX          ● Live
RX          ● Live
音訊路由   ● VoiceMeeter
網路       ● 穩定

[匯出診斷包]
```

### 進階層（折疊）

- App／Codex 版本與 checksum；
- thread／session ID；
- endpoint 名稱與 hashed ID；
- RTT、jitter、packet loss；
- transcript event 時間；
- 重連／中斷原因；
- evidence file 路徑；
- Copy technical details。

主畫面不顯示 p50/p95，直到量測方法修正且數字可被信任。錯誤的精確度比不顯示更差。

## 11. 置頂迷你窗

依模式只顯示一到兩條目標字幕：

```text
┌──────────────────────────────────────────┐
│ ● Live  00:18:42      [靜音] [停止]      │
│ 我聽到：可以確認設備驗證時程嗎？         │
│ 對方聽到：We can begin production…       │
└──────────────────────────────────────────┘
```

- 可拖曳與記住位置；
- 不提供設定或診斷；
- 有問題時只顯示一句狀態＋「展開」；
- 鍵盤可聚焦；
- Stop 需確認或長按，避免誤觸。

## 12. 紀錄與摘要

紀錄頁採列表＋內容雙欄，不做 dashboard：

```text
08/29  Teams  24 分鐘  繁中↔英文   已摘要
08/28  Media  18 分鐘  自動→繁中   未摘要
```

內容頁：

- 逐字稿 tab；
- 摘要 tab；
- 重點、決策、待辦、未決問題與時間戳；
- 產生／重新產生摘要；
- 開啟資料夾；
- 刪除單場／全部刪除。

正式版應在 UI 明確標示目前儲存策略。現有 Beta 的永久明文保存屬高風險；正式發布前應改為本機加密或要求使用者再次確認。

## 13. Responsive 與 Accessibility

- 建議最小視窗 820×620；
- ≥1100px：Meeting 雙欄；
- <1100px：TX／RX 垂直堆疊；
- <900px：診斷改全螢幕 panel；
- Touch target ≥40px，主要 Start／Stop ≥44px；
- 完整鍵盤操作與可見 focus ring；
- status 更新使用 polite live region，錯誤使用 assertive；
- 不依賴紅綠色辨識；
- 字幕字級可在 90–160% 調整；
- 支援 reduced motion、light／dark system theme。

## 14. Preserved／Improved／Removed

### Preserve

- 兩條獨立 GPT‑Live session；
- VoiceMeeter／VB‑CABLE route guard；
- TX／RX mute 與 Stop；
- 來源／目標 transcript；
- evidence redaction；
- ChatGPT OAuth 由 Codex 管理。

### Improve

- 從單一 POC 表單改為 mode-first；
- 只顯示當前模式需要的設定；
- 將字幕升為 Live 畫面的主體；
- 把診斷移入抽屜；
- 加入明確 Connecting／Degraded／Blocked 狀態；
- 以繁中為主，英文只作輔助。

### Remove

- POC 用的四裝置永久同屏；
- 無法信任的 TTFA 顯示；
- 每個資訊都包成卡片；
- 技術 thread ID 出現在主畫面；
- Zoom／Teams 作為使用能力限制。

## 15. 需要保護的技術契約

正式 UI 重構不能破壞：

- `thread/realtime/*` start／SDP／stop 行為；
- TX／RX 不共用 thread 或 PeerConnection；
- route validation 與 feedback 防護；
- OAuth token 不進 renderer／log／evidence；
- transcript 不意外寫入 diagnostic bundle；
- Start 不可重入；
- Stop 必須釋放 MediaStream、AudioContext、PeerConnection 與 app-server；
- 未獲使用者操作前不可啟動 live audio session。

## 16. v0 原型範圍

確認本方案後，第一個可點擊 v0 只做：

1. OAuth 未登入／已登入；
2. Ready 的三種模式切換；
3. Meeting／Media／Microphone 的欄位顯示差異；
4. Connecting；
5. Live 字幕；
6. Degraded／Blocked；
7. 診斷抽屜；
8. 置頂迷你窗示意。

v0 不接真實 GPT‑Live，不修改 Phase 1 音訊核心；目的是先確認資訊架構、密度與視覺方向。

## 17. 設計確認點

開始 v0 前需確認：

1. 是否採用 **Quiet Control／安靜控制台**；
2. 是否接受頂部三入口，不使用大型 sidebar；
3. 是否接受三種 mode-first 操作方式；
4. Meeting Live 採雙欄、Media／Microphone 採單欄；
5. 是否接受系統 light／dark theme；
6. TransLive 正式 logo／icon 尚未提供，v0 將使用明確的 `[Logo]` placeholder，不自行繪製假 logo。
