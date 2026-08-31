# TransLive 正式版 UI 設計方案

> **階段：**正式 Shell 實作中；設計 v0 已併入正式 UI
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
- Zoom／Teams 快速裝置設定與 session 結束後還原；
- 來源字幕與目標字幕；
- 即時狀態、mute、停止與錯誤復原；
- 延遲、網路、音訊與裝置診斷；
- 本機逐字稿、單場摘要、跨場摘要匯整及刪除；
- 置頂迷你字幕窗；
- 可縮至 Windows 系統匣（Tray），不中斷進行中的翻譯；
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
├─ 診斷抽屜
│  ├─ 快速健康檢查
│  ├─ TX／RX 指標
│  ├─ 版本與 session
│  └─ 匯出遮罩診斷包
└─ Windows 系統匣
   ├─ 顯示／隱藏主視窗
   ├─ 翻譯狀態與目前模式
   ├─ mute／開始／停止
   ├─ 開啟診斷
   └─ 完全結束
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

### 7.2 Zoom／Teams 快速裝置設定

Meeting Ready 畫面提供單一「快速設定 Teams／Zoom」動作，採安全的三層策略：

1. 偵測 Teams／Zoom 是否已安裝及正在執行；
2. 以顯示名稱把瀏覽器裝置解析為 Windows 原生 IMMDevice ID；
3. 保存目前 Windows 預設通訊 Mic／Speaker，暫時切換為 TransLive 虛擬端點；
4. 驗證 **Windows 通訊預設** 已改為預期的原生端點；
5. 開啟 Teams／Zoom 裝置設定並要求使用者確認 App 實際選取相同裝置。

Windows 預設已變更不等於 Teams／Zoom 一定正在使用它；UI 絕不將前者顯示為會議 App 已設定成功。不以脆弱的滑鼠座標自動點擊 proprietary UI 作為唯一方案。已知版本可提供 UI Automation best-effort，但失敗時必須回退到清楚的人工確認流程。

```text
快速設定 Microsoft Teams

✓ 已偵測 Teams
✓ Windows 通訊麥克風：Voicemeeter Out B2
✓ Windows 通訊喇叭：Voicemeeter Input
● 驗證 Windows 預設
○ 請在 Teams 確認實際裝置

☑ 停止翻譯後還原原本裝置

[套用 Windows 預設] [開啟 Teams 裝置設定]
```

狀態：未安裝、未執行、解析原生端點中、Windows 預設已更新、需要 App 人工確認、還原完成、還原失敗。Live 開始前必須顯示 Windows 實際預設與會議 App 待確認狀態，不以「按過按鈕」等同 App 設定成功。

### 7.3 媒體翻譯

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

### 7.4 麥克風翻譯

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

## 12. Windows 系統匣 Tray

關閉主視窗時預設縮至系統匣，不中止正在進行的 session。第一次操作必須提示「縮至系統匣後翻譯仍會繼續」。設定中可改為「關閉視窗即結束」。

Tray icon 使用 `assets/translive-brand/translive-mark.svg` 產生的 Windows ICO／PNG 尺寸，並以小型狀態 badge 區分：

- 無 badge：Ready／Stopped；
- 綠點：Live；
- 黃點：Degraded；
- 紅點：Blocked／Disconnected。

右鍵選單依狀態動態顯示：

```text
TransLive · 雙向會議 · Live
─────────────────────────
顯示 TransLive
TX 靜音
RX 靜音
停止翻譯
開啟診斷
─────────────────────────
完全結束
```

非 Live 狀態改為：

```text
TransLive · Ready
開始上次模式
顯示 TransLive
設定
完全結束
```

Tray tooltip 必須顯示目前模式與通道狀態；斷線時送出 Windows notification，但不得在通知中顯示逐字稿或敏感會議內容。

## 13. 紀錄與摘要

紀錄頁採列表＋內容雙欄，不做 dashboard：

```text
08/29  Teams  24 分鐘  繁中↔英文   已摘要
08/28  Media  18 分鐘  自動→繁中   未摘要
```

內容頁：

- 逐字稿 tab；
- 摘要 tab；
- 重點、決策、待辦、未決問題與時間戳；
- 產生／重新產生單場摘要；
- 開啟資料夾；
- 刪除單場／全部刪除。

摘要匯整：

- 歷史列表可多選 2 個以上紀錄；
- 頂部顯示「匯整摘要」動作；
- 使用同一 Codex OAuth 的文字模型，不占用 GPT‑Live session；
- 固定輸出：跨場共同主題、決策演變、未完成待辦、重複問題、衝突資訊、來源場次與時間戳；
- 不推測未指定的負責人、期限或結論；
- 生成前明確提示將選取的逐字稿再次送至模型；
- 結果保存為獨立 Markdown，可重新產生、匯出或刪除；
- 單場摘要與跨場匯整必須視覺區分，避免誤認為原始會議紀錄。

正式版應在 UI 明確標示目前儲存策略。現有 Beta 的永久明文保存屬高風險；正式發布前應改為本機加密或要求使用者再次確認。

## 14. Responsive 與 Accessibility

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

## 15. Preserved／Improved／Removed

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

## 16. 需要保護的技術契約

正式 UI 重構不能破壞：

- `thread/realtime/*` start／SDP／stop 行為；
- TX／RX 不共用 thread 或 PeerConnection；
- route validation 與 feedback 防護；
- OAuth token 不進 renderer／log／evidence；
- transcript 不意外寫入 diagnostic bundle；
- Start 不可重入；
- Stop 必須釋放 MediaStream、AudioContext、PeerConnection 與 app-server；
- 未獲使用者操作前不可啟動 live audio session。

## 17. v0 原型範圍

確認本方案後，第一個可點擊 v0 只做：

1. OAuth 未登入／已登入；
2. Ready 的三種模式切換；
3. Meeting／Media／Microphone 的欄位顯示差異；
4. Zoom／Teams 快速設定 modal 與成功／人工確認狀態；
5. Connecting；
6. Live 字幕；
7. Degraded／Blocked；
8. 診斷抽屜；
9. 置頂迷你窗示意；
10. 系統匣右鍵選單示意；
11. 紀錄多選與摘要匯整示意。

已確認的 v0 已併入正式 Electron UI；正式 Shell 維持既有 Phase 1 音訊核心與 IPC 安全邊界。

## 18. 設計確認點

開始 v0 前需確認：

1. 是否採用 **Quiet Control／安靜控制台**；
2. 是否接受頂部三入口，不使用大型 sidebar；
3. 是否接受三種 mode-first 操作方式；
4. Meeting Live 採雙欄、Media／Microphone 採單欄；
5. 是否接受系統 light／dark theme；
6. v0 使用已建立的 `assets/translive-brand/translive-mark.svg`，正式發布前再輸出完整 Windows ICO／PNG asset set。

## 19. 正式實作切片與 TDD seam

正式版以垂直切片交付，不先建立完整元件庫或一次重寫所有 POC 畫面。

| Slice | 可交付能力 | 驗證 |
| --- | --- | --- |
| 1. Mode runtime | Meeting 啟動 TX＋RX、Media 只啟動 RX、Microphone 只啟動 TX | 既有 translation orchestration seam 的行為測試 |
| 2. Formal shell | Logo、繁中導覽、OAuth 狀態、Ready／Connecting／Live／Blocked | Electron IPC＋畫面 state 的高層測試 |
| 3. Mode setup | 各模式只要求必要裝置；字幕與控制依模式切換 | mode config 驗證與 renderer state |
| 4. Quick setup | Teams／Zoom 偵測、暫存／還原裝置、人工 fallback | Windows adapter fixture＋Windows 實測 |
| 5. Tray | 隱藏／顯示、動態 menu、mute／stop、退出 | Electron Tray adapter＋手動 Windows 驗證 |
| 6. Records | 本機逐字稿、單場摘要、跨場摘要匯整 | 檔案 schema、摘要輸入／輸出契約 |
| 7. Hardening | 診斷、可及性、錯誤狀態、Windows 打包 | 自動檢查＋真實使用流程 |

主要自動測試 seam 沿用 Phase 1 的 translation orchestration contract：給定模式、路由與外部 adapter，從公開 Start／Mute／Stop／State 觀察行為，不測 private helper。Electron、Windows 裝置與會議 App 行為在 adapter 邊界做少量整合測試，最後以 Windows 真機驗證。

第一個 tracer bullet 是 Mode runtime；它必須在不要求多餘裝置的情況下，只建立目前模式需要的 GPT‑Live session。

## 20. 2026-08-31 修訂：依模式隔離 Windows 音訊生命週期

實機會議顯示「App 啟動即切換所有 Windows 音訊角色」會把 Edge／YouTube／系統聲音一併混入 Meeting RX。故取消不分模式的全域切換；仍不使用瀏覽器座標自動化或未文件化 per-app routing。

主實例啟動時只做 recovery 與 snapshot，按「開始翻譯」時才依模式套用：

| Mode | Capture 變更 | Render 變更 |
| --- | --- | --- |
| Meeting | 只把 Communications 設為 `Voicemeeter Out B2` | 只把 Communications 設為 `Voicemeeter Input` |
| Media | 不變更 | 只把 Console／Multimedia 設為 `Voicemeeter Input` |
| Microphone | 只把 Communications 設為 `Voicemeeter Out B2` | 不變更 |

- Console／Multimedia／Communications 未列出的角色保持原端點；Meeting 不再捕獲 YouTube 或一般系統聲音；
- 單次翻譯停止、取消或 start failure 後立即還原原始 Windows 角色；完整退出再做 idempotent safety restore；
- Teams／Zoom Quick Setup 僅在 Meeting target 套用後設定 Communications，停止時先還原 meeting-app snapshot，再還原 mode target；
- 第二個 Electron 實例不得碰觸 checkpoint；checkpoint 保存 original、mode target 與 prepared／applying／active phase；
- 異常退出只在目前端點等於已保存 target 時自動還原；若使用者已另行改動則 fail closed 並要求人工確認；
- endpoint ID 不進 renderer、log 或 evidence。

GPT remote track 播放順序必須為 `autoplay=false → setSinkId(target) → srcObject → play()`；禁止在 sink 綁定前把第一個 frame 送到 Windows default。

開始前執行可測的 VoiceMeeter route health seam：TX test tone 只能出現在 B2、RX test tone 只能出現在 B1，且反向 bus 必須低於 leakage threshold；任何 getUserMedia／setSinkId／level gate 失敗都阻止開始，不以靜默 fallback 取代。

公開 TDD seam 為 `WindowsAudioDefaultsController.prepare()/applyMode()/restore()/status()`、all-role adapter、純 mode-target builder、renderer sink-binding helper、bus-level assessment，以及 Electron start/stop/exit orchestration。

## 21. 2026-08-30 修訂：自適應同步翻譯節奏

### 21.1 問題與不可兼得條件

固定語速、逐字完整、永遠零積壓無法同時保證。正式預設優先順序為：

1. 自然且穩定的一般人語速；
2. 將聲音與目標字幕維持在有界延遲內；
3. 保留意思、名稱、數字與技術詞；
4. 積壓時先壓縮贅詞與合併未送出的短句，不以突然高速朗讀追趕，也不靜默丟棄已承諾內容。

GPT-Live 目前沒有公開的每句 TTS rate 參數；因此第一階段不宣稱能鎖定絕對語速。採用同步翻譯常見的 adaptive segmentation／wait policy，加上 bounded jitter buffer 與回授式 backlog control。WSOLA／AudioWorklet time-scale modification 保留為實測仍不足時的第二階段，不先加入 PCM 重取樣複雜度。

### 21.2 `PacingPolicy`

所有參數集中在可驗證、可版本化的 policy，不散落 magic numbers：

- 目標延遲區間、coalesce／lag-warning hysteresis、最大 scheduled backlog 與 rolling outstanding segment 數；
- 繁中文字、拉丁詞與數字 token 的初始自然朗讀時間估算；
- 第一段、穩態段與 coalesced 段的目標朗讀時間，以及 semantic-boundary tolerance／單段硬 playout 上限；
- 最短可播能力（由 GPT-Live capability／實測提供，不等同全程固定切段）；
- tail transcript 與 appendSpeech drain 的有界等待時間；
- 未來可選的 time-scale 修正上下限。

目前實作的 `natural-sync` policy 是 schema version 1。政策值只在 `src/adaptive-pacing-controller.js` 集中定義；測試可傳入完整 policy override，production 不在 Phase controller、renderer 或 adapter 散落切段／語速常數。

預設 preset 為「自然同步」；後續可提供「最低延遲」與「字義完整」，三者都映射到同一 policy schema。

### 21.3 `AdaptivePacingController`

控制器是純邏輯公開 seam，輸入：

- 目標 transcript delta／final event 與明確時間戳；
- 已規劃、已 dispatch 與尚未 dispatch 的 segment；
- 目前 policy。

輸出是可觀察決策：`wait`、`flush`、`coalesce`、`lag-warning` 與 `dispatch`。切段以語意／標點邊界及預估朗讀時間為主，不以固定字數為唯一規則；但 punctuation 在未達 GPT-Live 實測最短可播能力前不得 flush。第一個 eligible clause 立即排程，後續段落以穩態目標時間排程；backlog 跨過 enter／exit hysteresis 後，才合併尚未 committed 的短句。已 committed 或已 dispatch 的文字絕不為追趕而刪除或加速。

目前 GPT-Live 沒有公開的 per-segment rate／動態 concise RPC，因此「簡潔等義、自然會話速度」由 TX／RX 系統 prompt 要求；controller 不假裝能在播放中改速。實際輸出時間校正與 WSOLA 仍是 P6 後的實測決策，不在本切片實作。

backlog 以預估毫秒計算：

```text
backlogMs = queuedEstimatedSpeechMs - elapsedPlayoutMs
errorMs   = backlogMs - targetBacklogMs
```

第一階段採有 hysteresis 的有界佇列控制，不直接使用會放大語音抖動的高增益 PID。控制動作只影響尚未送出的分段與 appendSpeech dispatch 時機；已開始播放的語音不突然變速。僅 arm queue head；若 backlog bound 暫存後續文字，會在已規劃播放結束時 wake 再判定，不會遺失或讓後段超車。

`thread/realtime/transcript/*` 的 flat experimental notification 沒有 itemId，不能安全區分原始翻譯與 `appendSpeech` playback。Windows 真實會議已證實文字比對 heuristic 會把 playback transcript 重新送入 pacing，形成 assistant-only amplification。正式路徑改以 `thread/realtime/item/started`、`item/transcript/delta`、`item/completed` 的 itemId 建立單向 translation item → playback item；playback item 永不得回到 pacing。偵測到 item-level 後忽略同 thread 的 flat transcript，舊 flat 路徑僅作相容 fallback，不再作 item-level production correlation。

### 21.4 字幕同步

- 原文字幕可即時顯示；
- 目標字幕以對應 speech segment 的 dispatch／output-start 為準，不在尚未朗讀時提前顯示；
- 診斷／evidence 僅保存 aggregate pacing 指標，不保存 transcript：policy id/version、目前／最大 projected backlog、scheduled/dispatched/fast-start/steady/coalesced segment 數、wait 與 lag-warning 次數；不保存 segment text 或 endpoint ID。

### 21.5 TDD 垂直切片與驗收

| Slice | 公開 seam | Red → Green 行為 |
| --- | --- | --- |
| P1 Policy／估算 | `AdaptivePacingController` | 相同輸入在不同語速估計下產生時間型切段，而非固定字數 |
| P2 Fast start | `AdaptivePacingController` | 第一個完整可播子句先送出，後續回到穩態段 |
| P3 Bounded backlog | `AdaptivePacingController` | 積壓跨過 hysteresis 才合併／要求精簡，不突然高速或丟內容 |
| P4 GPT-Live integration | `PhaseOneController` 公開事件與 fake app-server | RX head-only appendSpeech 順序、rolling outstanding cap、ordered echo suppression、Stop tail drain／unsent state 不回歸 |
| P5 Caption timing | renderer 公開 event contract | 目標字幕跟隨 speech segment dispatch／output，而非僅跟 transcript delta |
| P6 Windows 實測 | redacted evidence＋耳機觀察 | YouTube 長段落不再明顯忽快忽慢，初始與穩態延遲落在門檻內 |

初始驗收目標沿用 Phase 1：first translated audio P50 ≤ 1.5 秒、P95 ≤ 2.5 秒；穩態 backlog 以 1–3 秒為目標、正常情況不超過 4 秒。語速穩定度以 segment 實際毫秒／字（或詞）分布衡量，不能只靠主觀感受；Windows 真機結果可校正 policy 預設值，但演算法與測試不得綁死單一影片或單一說話者。

### 21.6 P1–P5 implementation status

已實作：versioned `natural-sync` policy、時間型估算、final 短句立即送出、fast-start／steady semantic segmentation、policy-capped long-clause split、head-only serialized appendSpeech、rolling outstanding/backlog admission、item-level playback 隔離、取消 generation guard、eligible Stop tail drain、安全 aggregate pacing evidence、RX target caption defer／dispatch advance。

尚未實作：WSOLA／AudioWorklet、播放中 time-scale modification、動態模型 concise RPC、以真實音訊 output-completion 校正 policy。這些都需要長段 YouTube／會議真機量測後才決定是否值得增加。

## 22. 2026-08-31 修訂：Restart 與嚴格翻譯契約

- Stopped 畫面的「再次開始」直接執行完整 `startTranslation()`，重建 GPT-Live thread、WebRTC peer／SDP、mode-scoped Windows route 與 route health；不得只返回 Ready，也不得要求再次執行 Teams／Zoom 快速設定。
- 每次 preflight 必須先套用 mode-scoped Windows route，再由 renderer 執行 VoiceMeeter B1／B2 tone probe；這會重新啟用 Chromium 對虛擬 Communications endpoint 的輸出。若 preflight、probe 或 startup 失敗，main-side cancel 必須還原該 route。
- 每次 Restart 使用新 renderer peer 與 main-side runtime；Start／Stop／Restart 仍遵守既有 cancellation、checkpoint 與 restore 順序。
- TX／RX init prompt 明確要求只忠實翻譯：問句仍翻成問句，禁止回答、解釋、建議、承接對話、補 filler、重用前句或無來源重複。
- 完整 final 短句（如 `Yes`、`No`、`OK`、`Thanks`、`好`、`是`）立即 flush；未 final 的短 fragment 仍等待，避免 partial transcript 抖動。
- TDD seams：renderer Restart click contract、`PhaseOneController.start()` prompt／fresh-runtime contract、`AdaptivePacingController.ingest()` final-short contract，以及 Windows 同 process Start → Stop → Restart 五輪 E2E。

## 23. 2026-08-31 修訂：TX／RX GPT-Live transport 硬隔離

Windows 雙方會議實測證明，雖然 renderer 的 TX sink=AUX、RX sink=Poly 且 VoiceMeeter bus 正確，共用一個 `CodexAppServer` client 的兩個 realtime thread 仍可能把 RX `appendSpeech` 音訊送到 TX WebRTC transport，經 AUX／B2 回傳遠端。TX muted、VAIO/B1-only 合成輸入時，B2 延遲出現 max RMS 0.0386；Poly→B2、Strip3→B2 均為零，故不得再只靠 threadId／sink label 宣稱隔離。

正式 ownership 契約：

- 每個 active direction 擁有獨立 `CodexAppServer` client（production 為獨立 app-server process）、單一 ephemeral thread、單一 realtime session 與單一 WebRTC SDP；
- client 建立時即綁定 direction；該 client 的 notification／protocolError／exit 不再查共用 thread map，也不得影響 sibling direction；
- RX pacing 與 `appendSpeech` 只能呼叫 RX client 及 RX thread；TX client API 永不可由 RX state 取得；
- Meeting 建立兩個 clients，Media／Microphone 各只建立一個；任一部分 startup 失敗、Cancel、Stop、Restart、Exit 都必須關閉所有已建立 clients，且 sibling close failure 不阻止其他 cleanup；
- evidence 可共用 run container，但 session、error、state、audio metric 必須保留 direction ownership；不得保存 SDP、endpoint ID 或 raw audio；
- renderer 仍維持 TX peer→AUX/B2、RX peer→Poly，但 main-side transport ownership 是第一道隔離，sink 是第二道隔離。

TDD／Windows ship gate：Meeting fake clients 必須證明 2 clients × 1 thread；RX appendSpeech 只出現在 RX client；交錯 TX notification 不可消耗 RX item；TX muted 且只注入 RX/B1 時，B2 必須維持 noise floor，RX 本機輸出必須存在。未通過此 cross-route gate 不得發行。
