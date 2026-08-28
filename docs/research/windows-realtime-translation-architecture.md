# Windows 即時中英語音翻譯：可行性與最低延遲架構簡報

> **查證日：2026-08-28**。本文只採用 OpenAI、Microsoft、Zoom、Teams 與 Microsoft 官方原始碼／文件。數值延遲目標均明確標為產品目標或工程估計，**不是 API SLA**。
>
> **先前對話連結**：已嘗試讀取 `https://chatgpt.com/share/6a918d55-1848-83ee-931b-975ef30e6068`，此執行環境只收到「頁面以 JavaScript 動態載入」而無可驗證內容；本文沒有臆測或引用其內容。

## 結論先行

| 項目 | 判斷 | 依據／限制 |
|---|---|---|
| 即時雙向口譯核心 | **可行，應先用 `gpt-realtime-translate`** | OpenAI 目前有專用的連續、語音對語音翻譯模型與 `/v1/realtime/translations` 端點；它在來源仍說話時輸出譯音與逐步文字。[官方翻譯指南](https://developers.openai.com/api/docs/guides/realtime-translation)、[模型頁](https://developers.openai.com/api/docs/models/gpt-realtime-translate) |
| 同時兩個方向 | **可行，但必須是兩個獨立翻譯 session 與兩條獨立音訊匯流排** | OpenAI 對雙人會話的建議正是每方向一個 translation session；把說話者混成一軌會使身分與重疊語音更難處理。[官方翻譯指南](https://developers.openai.com/api/docs/guides/realtime-translation#build-conversational-translation) |
| Zoom／Teams 整合 | **條件式可行，首版不需 SDK** | 兩個桌面客戶端皆讓使用者在裝置下拉選單選擇麥克風與喇叭；若 Windows 虛擬端點被正常列舉，OS 路由即足夠。官方文件**沒有保證任意第三方虛擬驅動都會被列出或不被租戶政策阻擋**，須實測。[Zoom](https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0060612)、[Teams](https://support.microsoft.com/en-us/teams/meetings/manage-audio-settings-in-microsoft-teams-meetings) |
| 使用者選「輸出聲音」 | **目前是 P0 未驗證／可能阻擋項** | 專用 translation session 的現行 schema 只文件化 `audio.output.language`，沒有 `voice` 欄位；不可承諾它支援可選聲音。[translation client events](https://developers.openai.com/api/reference/resources/realtime/translation-client-events) |
| Windows 自製虛擬驅動 | **可做，但不是 POC 第一階段** | SysVAD 是 WDM/WaveRT 虛擬音訊驅動樣本，但它不是真正可直接當 virtual cable 的 mixer；樣本甚至以 tone 模擬 capture／loopback。先用既有 cable 驗證路由，產品化才做驅動。[SysVAD](https://learn.microsoft.com/en-us/samples/microsoft/windows-driver-samples/sysvad-virtual-audio-device-driver-sample/) |
| 最低端到端延遲 | **沒有可引用的模型／網路毫秒保證，必須量測** | 官方要求以真實音訊測 first translated audio latency、end-of-utterance latency、重連與重疊語音；未提供此產品情境的 SLA。[官方翻譯指南](https://developers.openai.com/api/docs/guides/realtime-translation#test-quality-and-latency) |

**推薦決策：**以專用翻譯端點、兩個 session、兩組既有虛擬 cable、WASAPI、以及「桌面端直連 WebRTC + 小型 token broker」做最小 POC。不要先做 Zoom/Teams SDK、客製驅動、錄音系統、STT→文字 LLM→TTS 三段管線或自訂聲音。若「可選聲音」是不可退讓的 P0，先把它列為獨立 go/no-go 實驗；不能把它當作專用 translation API 已保證的功能。

---

## 1. 範圍與兩個同時方向

### 1.1 本 POC 要交付的行為

1. **外送（A）**：本機實體麥克風 → 中／英翻譯 → Zoom 或 Teams 選為麥克風的虛擬錄音端點。
2. **收聽（B）**：Zoom 或 Teams 選為喇叭的虛擬播放端點 → App 擷取 → 反向翻譯 → 本機實體耳機／喇叭。
3. A、B 可同時啟動；每條路徑獨立設定**目標**語言（中文或英文）、音量、mute、原音／譯音模式與字幕。
4. 首版只處理一位本機使用者的麥克風和「會議客戶端已混合的遠端輸出」；不宣稱能在 Zoom／Teams 混音後再還原每位遠端說話者。

### 1.2 建議的兩條隔離匯流排

```text
                       ┌──────────── 外送 A：本機 → 會議 ────────────┐
實體 Mic ─WASAPI capture→ A 翻譯 session（目標語言）→ App render
                                                   │
                                      [TL-Out Playback] ──配對──> [TL-Out Recording]
                                                                         │
                                                   Zoom / Teams 選作「麥克風」

                       ┌──────────── 收聽 B：會議 → 本機 ────────────┐
Zoom / Teams 選作「喇叭」
              │
 [TL-In Playback] ──配對──> [TL-In Recording] → App WASAPI capture → B 翻譯 session
                                                                         │
                                                          WASAPI render → 實體耳機／喇叭
```

這裡的「配對」是 virtual-audio-cable 類型端點的**單向 playback → recording** 資料通道，不是把同一個端點拿來同時讀寫。全雙工需要：

- **TL-Out 一組**：App 寫入其 Playback 端；Zoom／Teams 從其配對 Recording 端讀取麥克風資料。
- **TL-In 一組**：Zoom／Teams 寫入其 Playback 端；App 從其配對 Recording 端擷取會議輸出。

> **工程判斷：不要只用同一組 cable 同時承載兩方向。** 否則會議的遠端語音與要送出的譯音會匯在同一 capture bus，造成遠端語音回送、再翻譯與回音循環。這是訊號拓樸推論，非 Zoom／Teams 所保證的行為。

### 1.3 原音／譯音選項與防回授規則

| 輸出位置 | 首選預設 | 可選模式 | 不可違反的路由規則 |
|---|---|---|---|
| `TL-Out Recording`（送到會議） | **僅譯音** | 僅原音；原音＋譯音 | 只接受本機 Mic 的原音／A 譯音；絕不輸入 TL-In、實體喇叭輸出或 B 譯音。混音會讓遠端同時聽到雙語且因譯音延後而難懂，故預設關閉。 |
| 本機實體耳機／喇叭 | **僅譯音** | 僅原音；原音＋譯音（譯音出現時 duck 原音） | 只接受 TL-In 原音／B 譯音；絕不接回 TL-Out。用耳機作基線；喇叭模式要明顯警示聲學回授風險。 |
| 本機 Mic monitor | 關閉 | 僅耳機可開 | 不把 monitor 或實體輸出做為任何翻譯輸入。 |

**隔離機制：**在 App 內每一個音訊 frame 帶有不可變的 `sourceBus`（`physical-mic`、`tl-in`、`a-translated`、`b-translated`）；路由器拒絕把任何 render bus 回接至自己的 capture bus，啟動前比對端點 ID 不得重複。這是最小、可測的防循環機制；不是靠 AEC 猜測消回音。Zoom 官方也指出過近喇叭、同一空間多台開啟音訊的電腦會造成 echo／feedback，因此耳機不是可有可無的 UX 建議。[Zoom echo 說明](https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0061720)

---

## 2. 「GPT Live」今天應對應什麼

| 使用者口語名稱 | 現行官方模型／端點 | 是否適合作為本案主路徑 |
|---|---|---|
| 「GPT Live」 | 本次查到的精確模型名是 **`gpt-live-transcribe`**（頁面標題 *GPT Live Transcribe*），它是低延遲**語音轉文字**、輸出 transcript deltas，並非語音翻譯器。[模型頁](https://developers.openai.com/api/docs/models/gpt-live-transcribe) | 否；可日後做字幕／診斷，不應取代譯音。 |
| 即時語音翻譯 | **`gpt-realtime-translate`**，`/v1/realtime/translations`；連續輸入音訊並輸出譯音與來源／目標 transcript deltas。[模型頁](https://developers.openai.com/api/docs/models/gpt-realtime-translate)、[指南](https://developers.openai.com/api/docs/guides/realtime-translation) | **是，最低延遲基線。** 不用 `response.create`，也不等使用者回合 commit。 |
| 一般語音助理／可選內建聲音的評估分支 | **`gpt-realtime-2.1`**，標準 `/v1/realtime` session；其文件化 `audio.output.voice` 及一組內建聲音，但這是語音助理模型，不是專用連續口譯 session。[模型頁](https://developers.openai.com/api/docs/models/gpt-realtime-2.1)、[Realtime conversations](https://developers.openai.com/api/docs/guides/realtime-conversations) | 僅在「可選聲音」為 P0 時做比較實驗；不可假定與專用翻譯的延遲、連續性或品質相同。 |

### 專用翻譯模型的重要限制

- translation session 目前文件化可更新 `audio.output.language`、選配的來源轉寫與輸入降噪；其 `audio.output` schema 只有 `language`。因此「目標語言可設定」是事實；「來源語言選擇會傳到 API」與「可選 voice」目前都**沒有同等文件化證據**。[translation client events](https://developers.openai.com/api/reference/resources/realtime/translation-client-events)
- 中文輸入、英文輸入及所需中文語體（繁中／簡中、國語／粵語）的實際支援組合，官方翻譯頁沒有提供可據以承諾的語言矩陣。它是 POC 首日的實測 gate，不能因模型宣稱 multilingual 而跳過。
- 若改用一般 Realtime model，其官方文件說明聲音一旦在 session 中輸出過音訊便不能再更換；「使用者切換聲音」至少代表要建立新 session，而不是即時修改已播放中的 session。[Realtime conversations](https://developers.openai.com/api/docs/guides/realtime-conversations#voice-options)
- 專用翻譯模型頁目前列為按 realtime audio duration 計費、**$0.034/分鐘**，且 Free tier 不支援。兩方向是兩個連續 session，實際成本必須依實際音訊分鐘數與帳戶帳務觀測，而不是把這個單價當月費承諾。[模型與價格頁](https://developers.openai.com/api/docs/models/gpt-realtime-translate)、[Realtime 成本指南](https://developers.openai.com/api/docs/guides/realtime-costs)

---

## 3. 最小延遲架構

### 3.1 推薦協定：先 WebRTC，WebSocket 是受控比較／備援

| | WebRTC | WebSocket |
|---|---|---|
| OpenAI 文件的定位 | 瀏覽器捕捉／播放音訊時使用；來源為 media track、譯音為 remote track，瀏覽器不必自行重採樣或播放 PCM chunk。[翻譯指南](https://developers.openai.com/api/docs/guides/realtime-translation#choose-a-transport) | 伺服器已有 raw media pipeline（電話、broadcast、media worker）時使用；客戶端必須送 PCM、播放回傳 delta。[同上](https://developers.openai.com/api/docs/guides/realtime-translation#choose-a-transport) |
| 本案決策 | **推薦為 MVP 的第一選擇，前提是原生 Windows WebRTC spike 成功。** App 是音訊邊緣端，直連可避免媒體 proxy 多一跳。 | 只做 latency／格式診斷或 WebRTC 失敗時的架構備案；不要把一般 API key 放在已發佈的桌面程式內。 |
| 已知音訊處理 | 原生 WebRTC stack 必須把 WASAPI 音訊餵成 local track、把 remote track 導到 WASAPI／虛擬端點；這是**待驗證的 Windows 實作工作**，OpenAI 文件的免手動 PCM 說明明確針對 browser。 | 翻譯 WebSocket **只接受** base64 24 kHz、PCM16、mono、little-endian；建議每 200 ms 一塊。輸出用 `session.output_audio.delta` 串流播放。[client events](https://developers.openai.com/api/reference/resources/realtime/translation-client-events)、[server events](https://developers.openai.com/api/reference/resources/realtime/translation-server-events) |
| 延遲含義 | 官方說 client-side WebRTC 較一致／穩健，但沒有本案的毫秒承諾。[WebRTC 指南](https://developers.openai.com/api/docs/guides/realtime-webrtc) | 小於 200 ms 的 input chunk 會被 server buffer 到一個 200 ms engine frame；這是已知 latency floor 的一部分，不要誤判為模型全程延遲。 |

**具體選擇：**先做原生 WebRTC 直連的 A/B session；若兩天內無法把 Windows 音訊穩定餵入／取出 track，再以 WebSocket 取得可重現的 PCM 基線。後者的官方範例是 server 持有標準 API key 的 media pipeline；翻譯端點的短期 client secret 是否可用於原生桌面 WebSocket 不是本次官方指南明示的契約，需先驗證。若不能，就只能由受控 media relay 持 key，會增加延遲、營運與隱私面；不應悄悄把標準 key 放到 client。

### 3.2 元件最小化

```text
Windows App
├─ Device/router controller：選端點、兩條不可成環的 bus、原音/譯音 mixer
├─ Audio engine：WASAPI capture/render、bounded ring buffer、格式轉換、QPC 時戳
├─ Flow A translation transport：Mic -> target language -> TL-Out
├─ Flow B translation transport：TL-In -> target language -> physical render
├─ Playback queue：收到第一個完整譯音 delta 即排入，不等句尾／字幕
└─ UI：start/stop、語言、音量、原音/譯音、裝置、延遲與「正在傳送音訊」狀態

最小 HTTPS token broker（非媒體 proxy）
└─ 驗證 App 使用者／裝置 → 以伺服器保存的標準 API key 建立短期 translation client secret → 回傳給 App
```

- OpenAI 的翻譯 WebRTC 流程明確使用 `POST /v1/realtime/translations/client_secrets` 由開發者伺服器持標準 key 產生短期 secret，再由 client 用 `POST /v1/realtime/translations/calls` 建立連線。[官方流程](https://developers.openai.com/api/docs/guides/realtime-translation#create-a-browser-webrtc-session)
- 標準 API key 只存在 broker 的 secrets manager／環境，不寫入 MSI、桌面設定、log、crash report 或 Git。此設計把音訊留在 App↔OpenAI 的直接媒體路徑，broker 不轉送音訊。
- 若有帳號系統，server 端以穩定、隱私保護的雜湊內部使用者 ID 設 `OpenAI-Safety-Identifier`；這是 OpenAI 對 Realtime 的建議，且應由可信任 backend 設定。[Realtime overview](https://developers.openai.com/api/docs/guides/realtime#safety-identifiers)
- 端點應有 user authentication、每使用者 session／分鐘上限與濫用記錄；這是保護發 token 權限的工程控制，不是 OpenAI 現成替 App 做的功能。

### 3.3 音訊格式、VAD／PTT 與串流播放

1. **Windows 端點格式不要硬設成 24 kHz。** 對每一個 shared-mode endpoint 先取 `IAudioClient::GetMixFormat`；Microsoft 說這是該裝置 Windows audio engine 的 shared-mode mix format，並保證可用於該裝置 shared-mode initialization。[GetMixFormat](https://learn.microsoft.com/en-us/windows/win32/api/audioclient/nf-audioclient-iaudioclient-getmixformat)
2. **只在 WebSocket API 邊界重採樣。** 若實體／虛擬端點是 44.1/48 kHz、stereo、float，App 將它轉為專用翻譯 API 所需的 24 kHz mono PCM16 LE；這是由兩個格式契約導出的工程實作。不要在 UI thread 或每一個 callback 配置記憶體。
3. **WebSocket 的 200 ms 是硬事實。** translation server 以 200 ms engine frames 消費；更短 chunk 會被累積，更長則被切分並排隊。活躍 session 也要持續送 silence，否則稍後恢復的語音會被服務視為與前段連續而非真實停頓。[translation client events](https://developers.openai.com/api/reference/resources/realtime/translation-client-events#session-input-audio-buffer-append)
4. **專用翻譯不是傳統 VAD 回合。** 它從音訊流本身開始翻譯，不呼叫 `response.create`、不等 commit。若要 push-to-talk，只能是 App 層的 gate（未按時送靜音／不把 Mic 內容送入）；不能把它誤實作成一般 Realtime 的 VAD 回合。一般 `gpt-realtime-2.1` 的 `server_vad`、`semantic_vad`、`turn_detection: null`／手動 `response.create` 是「可選聲音評估分支」才需要比較的取捨；semantic VAD 官方也指出可能增加延遲。[Realtime conversations](https://developers.openai.com/api/docs/guides/realtime-conversations#disable-vad)
5. **收到即播。** WebSocket 的 `session.output_audio.delta` 是長度可變的 PCM16 chunk，官方要求完整 decode／queue，不能假設固定 sample 數；讀取事件附帶的 `sample_rate`／`channels`（schema 預設 24 kHz、mono）後再轉成 render endpoint 格式。第一個完整 delta 進入小型、有上限的 jitter queue 就 render；不等待句子、最終 transcript 或 `session.close`。[translation server events](https://developers.openai.com/api/reference/resources/realtime/translation-server-events#session-output-audio-delta)
6. **輸入降噪只從實測選擇。** translation session 文件化 `near_field`（耳機／近講）與 `far_field`（筆電／會議室）兩種輸入降噪提示。耳機 POC 先試 `near_field`，喇叭／遠場再獨立比較；不要宣稱它等於端到端 AEC。[translation client events](https://developers.openai.com/api/reference/resources/realtime/translation-client-events#session-update)

---

## 4. Windows 音訊拓樸：WASAPI、loopback、虛擬端點與驅動

### 4.1 各技術該用在哪裡

| 用途 | 最小作法 | 為何不是另一種作法 |
|---|---|---|
| 實體 Mic → A | WASAPI capture endpoint | 是明確、單一來源；保留端點 mix format 與 timestamp。 |
| B → 實體耳機 | WASAPI render endpoint | 最短、可控制的最後一跳；不把 B render 重新擷取。 |
| Zoom／Teams 會議輸出 → B | **優先擷取 TL-In 的配對 Recording endpoint** | 只拿會議送入的虛擬 bus，可隔離 App 自己的實體輸出。 |
| 無虛擬端點時的暫時診斷 | WASAPI loopback 擷取 Zoom／Teams 目前的 render endpoint | Microsoft 的 loopback 擷取的是 render endpoint 的 shared-mode mix；會混入其他系統／App 音訊，含本 App 的實體播放，故不能是全雙工產品預設。[Loopback recording](https://learn.microsoft.com/en-us/windows/win32/coreaudio/loopback-recording) |
| App 譯音 → Zoom／Teams Mic | render 到 TL-Out Playback，讓其配對 Recording endpoint 被會議選為 Mic | Windows user-mode App 不能憑空把 byte stream 變成系統 capture endpoint；需要既有 cable 或驅動提供端點。 |

WASAPI loopback 的已知限制是：必須以 `AUDCLNT_SHAREMODE_SHARED` 加 `AUDCLNT_STREAMFLAGS_LOOPBACK` 初始化，exclusive mode 不支援；保護內容也不能擷取。[Microsoft 文件](https://learn.microsoft.com/en-us/windows/win32/coreaudio/loopback-recording) 這正是為什麼它僅用於無 cable 時的診斷／single-flow spike，不是產品的回授隔離策略。

### 4.2 先驗證既有 virtual cable，再決定是否做驅動

| 階段 | 做法 | 可接受用途 | 不可假裝成什麼 |
|---|---|---|---|
| **原型** | 開發／測試機手動安裝一個有合法授權的既有 virtual-cable 方案，建立上文兩組獨立 pair。 | 驗證 Zoom、Teams 是否列出端點、全雙工路由、buffer 行為與延遲。 | 不把第三方 cable 打包、靜默安裝或宣稱可再散布；先查其 EULA／企業部署條款。 |
| **可散布產品** | 只有當「無第三方依賴、可控 UX／支援、企業部署」真是需求時，才以自有驅動提供 TL-In／TL-Out bus。 | 有意識地承擔 WDK、測試、signing、update、crash/support 成本。 | 不把 SysVAD sample 編譯後直接當產品；它不是 ready-made cable。 |

### 4.3 SysVAD 的正確定位

Microsoft 的 [SysVAD](https://learn.microsoft.com/en-us/samples/microsoft/windows-driver-samples/sysvad-virtual-audio-device-driver-sample/) 是可供學習／衍生的 WDM 虛擬音訊驅動 sample，使用 WaveRT，展示多個音訊端點與相關 topology。其官方 README 同時明說 sample virtual driver **不實作真實 audio mixing**，capture／loopback 是以 sine tone 模擬；所以產品驅動仍要自行實作兩條獨立 render→capture bus、clock／buffer ownership、格式協商、power／device removal、錯誤復原與 HLK 測試。[SysVAD 原始 README](https://github.com/microsoft/Windows-driver-samples/blob/main/audio/sysvad/README.md)

若真的進入這一階段：

- 用 SysVAD endpoint/topology/INF 作為**起點**，不是 runtime 依賴；將 sample ID、GUID、hardware ID、品牌與測試假設全部替換。Microsoft 有專頁說明 sample 到 production driver 必須做的變更。[From sample to production](https://learn.microsoft.com/en-us/windows-hardware/drivers/gettingstarted/from-sample-code-to-production-driver)
- 來源 repository 的 [LICENSE](https://github.com/microsoft/Windows-driver-samples/blob/main/LICENSE) 是 MS-PL；複製／修改前讓法務確認通知、散布與第三方元件義務。
- driver package 需要 INF、catalog 與相符的簽章；catalog 內每個檔案 hash 在封包變動後失效。[Catalog files](https://learn.microsoft.com/en-us/windows-hardware/drivers/install/catalog-files)
- 開發測試可涉及 test signing；SysVAD 部署文件要求目標機開啟 `TESTSIGNING`、安裝測試憑證，且可能需暫停 BitLocker／Secure Boot。[SysVAD 部署說明](https://learn.microsoft.com/en-us/samples/microsoft/windows-driver-samples/sysvad-virtual-audio-device-driver-sample/#setup-the-target-computer)
- 對客戶散布，Microsoft 將 HLK-tested dashboard signing 列為推薦；attestation signing 不需 HLK、定位為 testing，不能發佈到 retail Windows Update，且不是 Windows Certified。[Driver signing options](https://learn.microsoft.com/en-us/windows-hardware/drivers/dashboard/driver-signing-offerings)

---

## 5. Zoom／Teams：OS 端點足夠，但音訊處理要實測

### 5.1 為何第一版不做 SDK

- Zoom 桌面 App 的 Audio 設定可選擇／測試 speaker 和 microphone；開會中也能由 Mute 旁箭頭換裝置。[Zoom 設定](https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0060612)、[Zoom 裝置疑難排解](https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0060836)
- Teams Desktop 在 **Settings > Devices > Audio settings** 選 speaker/mic，可 Make a test call；會議中可以從 Mic 旁選單進 More audio settings。[Teams call settings](https://support.microsoft.com/en-us/teams/calls-devices/manage-your-call-settings-in-microsoft-teams)、[Teams meeting audio](https://support.microsoft.com/en-us/teams/meetings/manage-audio-settings-in-microsoft-teams-meetings)

因此本範圍中「把音訊送進／取出會議」只需使用者選擇 Windows OS endpoint；**不需要 SDK**。這不表示 App 可控制會議、取得分軌、取得與會者身分或繞過組織政策；那些都不在本 POC。

### 5.2 必跑的處理設定實驗（皆為假設，不是預設承諾）

| 平台 | 官方已知控制 | 要驗證的假設／判定 |
|---|---|---|
| Zoom | 預設麥克風模式會使用噪音抑制與 echo cancellation；Audio > Advanced 可將 Windows driver signal processing 設成 Raw/Off，亦可調 echo cancellation。[Zoom Audio 設定](https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0060612)、[Advanced](https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0066398) | 比較預設、Windows signal processing Off、echo 設定。**假設**：較少處理可能避免合成譯音被錯當作噪音；反面是可能更易有回音或音量問題。不可預設關閉所有處理。 |
| Teams | 可選 speaker/mic；Noise suppression 預設開啟，可在 Devices／會議 Audio settings 切換；官方建議在低噪音高保真麥克風情境可關閉。[Teams noise suppression](https://support.microsoft.com/en-us/teams/meetings/reduce-background-noise-in-microsoft-teams-meetings) | 比較預設、可用的 suppression off／背景噪音／voice isolation。**假設**：voice isolation 或噪音抑制可能改變合成語音；由錄音與遠端聽感判定。High fidelity music mode 明確是音樂、非一般語音的對照組，不當作預設。[Teams high fidelity](https://support.microsoft.com/en-us/teams/notifications-settings/use-high-fidelity-music-mode-to-play-music-in-microsoft-teams) |
| 兩者 | 裝置／設定可受版本、硬體與 IT 管理政策影響。 | 確認 TL-In/TL-Out 在選單中出現、切換後立即生效、沒有被「通訊裝置」優化或企業白名單排除。失敗即記錄版本／policy，不做繞過。 |

---

## 6. 延遲：硬事實、工程預算與量測

### 6.1 已有來源的硬事實（不是 SLA）

| 硬事實 | 對延遲設計的含義 |
|---|---|
| 專用翻譯連續翻譯來源音訊，不等 `response.create`／turn commit，並在來源仍說話時回傳譯音。 | 基線不要建立「等整句 STT→翻譯→TTS」的三段 pipeline。[OpenAI](https://developers.openai.com/api/docs/guides/realtime-translation) |
| WebSocket input 必須是 24 kHz PCM16 mono LE；服務以 200 ms engine frames 消費，短於 200 ms 的資料會被 buffer。 | WebSocket 路徑從第一個音訊 sample 到可被服務消費，至少包含一個 200 ms 聚合條件；不要用 20 ms callback 就宣稱 API 已開始翻譯。[事件規格](https://developers.openai.com/api/reference/resources/realtime/translation-client-events#session-input-audio-buffer-append) |
| 翻譯輸出 delta 是可變長 PCM16，schema 有 sample rate／channel metadata。 | 逐 delta 串流入有界播放 queue；不可等固定 frame 或整句。[事件規格](https://developers.openai.com/api/reference/resources/realtime/translation-server-events#session-output-audio-delta) |
| WASAPI loopback 取 shared render mix，exclusive 不支援。 | 它不是隔離會議音訊的安全產品路徑。[Microsoft](https://learn.microsoft.com/en-us/windows/win32/coreaudio/loopback-recording) |
| OpenAI 文件要求用真實音訊測 first audio、句尾、重疊、重連。 | 沒有可直接引用的模型推理毫秒數、WAN jitter 或 Zoom／Teams 設備 buffer 保證。[OpenAI](https://developers.openai.com/api/docs/guides/realtime-translation#test-quality-and-latency) |

### 6.2 提議的 POC 延遲預算（全是工程目標）

**量測邊界：**從 App 在來源 capture 取得第一個語音 sample 的單調時戳，至 App 將第一個對應譯音 sample 排入目的端 render buffer。外送終點是 TL-Out（Zoom/Teams 讀取之前）；收聽終點是本機實體耳機 render。這不包含 Zoom／Teams 把資料送到遠端參與者的網路延遲，也不把會議服務本身混入 App 內的 B 路徑。

| 區段 | WebRTC P50 / P95 **預算目標** | WebSocket 的額外已知條件 | 備註 |
|---|---:|---:|---|
| WASAPI capture、必要重採樣、App 排程 | ≤ 40 / 100 ms | 同左 | 需以 endpoint／CPU 實測；不是 Windows 保證。 |
| 送入服務前的聚合 | ≤ 40 / 80 ms | **200 ms engine frame** | WebRTC 的實際 packetization 待 spike；WebSocket 200 ms 是來源事實，不是可縮成 20 ms 的目標。 |
| 網路 + OpenAI 首個譯音 | ≤ 700 / 1,200 ms | 同左 | 最大不確定性；不可填成假精確 SLA。 |
| 接收、短 jitter queue、render | ≤ 120 / 220 ms | 同左 | queue 必須有上限，jitter 時丟過期語音／顯示 delayed，而不是無限堆積。 |
| **端到端第一個譯音（產品 POC gate）** | **P50 ≤ 900 ms；P95 ≤ 1,600 ms** | 預期會受 200 ms 聚合壓力 | 在固定硬體、耳機、良好網路、定義好的測試句下判定；不是 OpenAI、Windows、Zoom 或 Teams 保證。 |

若 WebRTC 無法過 gate、而 WebSocket 因 200 ms frame 仍能穩定達標，產品可依量測選 WebSocket；若兩者都不能，先停止驅動工作並檢查網路區域、model／語言輸出、buffer 與必要的產品目標，而不是用更多 buffer 掩蓋問題。

### 6.3 量測方法

1. 為每個 A/B session 指派 `flowId`、frame sequence、來源 endpoint ID／format 與單調 QPC timestamp；至少記錄：`t0_capture`、`t1_transport_send`、`t2_first_remote_audio_or_delta`、`t3_first_render_enqueue`、重連／error／queue depth。
2. **軟體指標**：`t3 - t0` 是 App 路徑可重複比較的 first-audio latency；分拆 `t1-t0`、`t2-t1`、`t3-t2` 找出是端點、網路／模型或 playback queue。
3. **實體指標**：用固定 chirp／語音樣本及第二張錄音介面或外部錄音器量測「實體 mic 收到」到「耳機／喇叭真正發聲」的 waveform 對齊；不要把寫入 `IAudioRenderClient` 當成空氣中已發聲。外送另以 TL-Out 配對 Recording endpoint／第二台測試客戶端確認會議實際讀到資料。
4. 每個條件至少蒐集 100 次短句 first-audio、30 次較長句尾資料，報 p50、p95、最大值、dropout、queue overflow、重連與語言品質；每份報告要帶硬體、Windows、Zoom／Teams、driver、模型名、網路 RTT/丟包條件。
5. 中斷／重疊案例一定要測：短暫停頓、使用者在先前譯音尚未播完時再說、兩個遠端人同時說、10 分鐘雙向連續、Wi-Fi jitter／斷線重連、44.1/48 kHz 和 mono/stereo endpoint、切換裝置、原音／譯音 mix 切換。

---

## 7. 主要風險與處置

| 風險 | 為何是真風險 | 最小處置／gate |
|---|---|---|
| 翻譯失真、姓名／數字／日期錯誤 | OpenAI 自己要求用真實語言對、名稱、數字、日期、金額、領域術語、code-switching 及口音測試。[指南](https://developers.openai.com/api/docs/guides/realtime-translation#test-quality-and-latency) | 建中英雙語 golden set，雙語人工評分；高風險數字不作自動決策，只做語音呈現／字幕標示。 |
| 遠端多人重疊 | Zoom／Teams speaker output 已是混音；OpenAI 指出混軌使身分與重疊處理更難。 | POC 明示「混音遠端流」限制；不做 diarization 承諾。 |
| half/full duplex、barge-in | 兩方向若共用 session／bus，容易互相餵音或停止播放。 | 一方向一 session、兩對 cable、每 flow 狀態機與中斷測試。 |
| 聲學／數位 feedback | 喇叭會被實體 Mic 收到；loopback 又可收整個 shared mix。 | 耳機基線、拓樸 cycle check、TL-In/TL-Out 分離；不以 AEC 作唯一防線。 |
| sample-rate／channel 不符 | Windows mix format 由端點決定；WebSocket 翻譯 input 有固定 24 kHz mono PCM16 契約。 | 開啟時記錄 format，集中式高品質 resampler，矩陣測 44.1/48 kHz、mono/stereo。 |
| network jitter、失連、session 到期 | 連續串流必受網路影響，session 有 `expires_at`；無限 buffer 會讓口譯越來越晚。 | 有界 queue、delayed/reconnecting UI、重建 session、量測 p95／dropout；不要暗中堆積。 |
| 可選聲音／聲音可用性 | 專用 translation schema 未文件化 `voice`；一般 Realtime 的 voice 也不能在已輸出音訊後切換。 | P0 feature gate；未過前 UI 只能顯示「服務決定的譯音聲音」，不可列出假的 selector。 |
| 隱私、錄音與告知 | 兩方向會把會議音訊送到雲端。OpenAI 說 API 資料預設不拿來訓練，但 abuse-monitoring logs 預設最多保留 30 天；資料保留控制的資格／端點覆蓋須逐專案確認。[Data controls](https://platform.openai.com/docs/models/default-usage-policies-by-endpoint) | 首啟動提供明確告知與使用者確認、顯示 active indicator、預設不落地錄音／逐字稿、先做組織／法域審查。不要假設 Zoom／Teams 內建「錄影」通知會自動涵蓋外部虛擬裝置 App。 |
| API key 濫用 | 桌面二進位檔與設定檔不是可信任 key vault。 | 僅 broker 保存標準 key；短期 client secret、App auth、rate limit、撤銷與事故輪替。 |
| 驅動支援、簽章與更新 | Kernel driver 需要封包簽章、相容性與支援；attestation/HLK 的散布能力不同。 | 驅動排到第三階段，先以 cable 買到產品證據；若做則獨立 security/release workstream。 |
| Zoom／Teams／Windows 前處理 | 噪音抑制、AGC、echo cancellation、voice isolation 可能改變合成語音，且版本／租戶可變。 | 每平台跑預設與受控設定矩陣；依遠端錄音／聽感選預設，不硬碼「關閉處理」。 |

**資料保留注意：**OpenAI 資料控制表明列 `/v1/realtime` 為 ZDR eligible，但該表沒有把 `/v1/realtime/translations` 獨立列成一列。本案不能自行推斷 translation 子端點一定已涵蓋；若需要 ZDR／資料地域，先向 OpenAI 取得本帳戶與此端點的書面確認。

---

## 8. 分階段建議與明確 go/no-go

### Stage 0 — 無虛擬裝置的 latency spike（先做）

- 實體 Mic → 專用翻譯 → 實體耳機，先只跑單方向，再同時兩 session。
- 建 token broker、直連 WebRTC spike、timestamp／quality logging；可在受控開發環境用 WebSocket 做 PCM 基準，不可把 key 隨產品交付。
- **Go：**`gpt-realtime-translate` 實際接受中／英文來源且能輸出需求目標語言；WebRTC 或安全的替代 transport 達到已定義的 POC latency gate。
- **No-go：**中文目標／輸入不可用、session 行為不穩、first-audio p95 長期超標，或聲音選擇是 P0 而專用端點無可接受方案。此時停止，不做 driver。

### Stage 1 — 既有 virtual cable 整合（POC）

- 手動建立 TL-In、TL-Out 兩對，讓 Zoom、Teams 各自手動選 speaker／mic。
- 跑完整中↔英、原音模式、回授、端點格式與網路測試矩陣。
- **Go：**兩平台都能列舉且穩定使用端點；10 分鐘全雙工無數位回路；耳機條件下目標 latency／品質通過。
- **No-go：**必須靠系統 loopback 才能取得乾淨會議音，或只有把 A/B 接同一 bus 才能運作；先修拓樸／選 cable，不做「先上自訂 driver」的逃避性擴張。

### Stage 2 — 自有已簽章 virtual audio driver（只在產品需要時）

- 只有當第三方授權、安裝 UX、企業 IT、branding 或支援需求明確要求自有端點時才啟動。
- 定義 Windows 版本／x64／ARM64、安裝權限、rollback、telemetry、crash handling、HLK／簽章／Windows Update（如需要）計畫。
- **Go：**Stage 1 的使用價值與延遲均證實，且已核准 driver 成本與散布策略。
- **No-go：**產品仍可由授權 cable 滿足，或 POC 尚未證明 API／聲音需求可行；不寫 kernel code。

### 現在不要建

- Zoom／Teams SDK、會議控制或分軌抓取；OS 端點已足夠驗證本範圍。
- 自訂 driver、APO/AEC、客製 mixer 或自動裝置切換。
- STT→文字翻譯→TTS 三段備援管線、RAG／工具型語音助理、錄音檔／長期 transcript store。
- 自訂／克隆聲音；若日後要做，需另行確認 API eligibility、聲音同意與授權，而不是把它藏在本 POC。

---

## 9. 前兩週 POC 計畫

| 工作日 | 最小成果 | 每日 gate |
|---:|---|---|
| 1 | 鎖定「繁中／英文」定義、中文語體、聲音是否 P0、隱私告知文案；建立付費可用的 OpenAI project 與 broker 威脅模型。 | 不把標準 API key 放進桌面 App；決定資料保留／地域需求。 |
| 2 | 用真實中英短句驗證 `gpt-realtime-translate` 的目標語言、輸出 audio delta／remote track、source/target transcript；記錄未文件化的 source／voice 行為。 | 若中文語體或可選聲音是硬要求且未達，升為產品決策，不繼續假設。 |
| 3–4 | 原生 Windows WebRTC 音訊 spike，單向 Mic→耳機；以 WebSocket PCM path 作受控比較（若安全認證方案明確）。 | 產出 `t0…t3` trace、first-audio p50/p95、dropout；選一條可交付 transport。 |
| 5–6 | WASAPI shared-mode capture/render、format logging、bounded queue、兩 session 並行；不做 driver。 | 44.1/48 kHz、mono/stereo 都不崩潰；未出現無限延遲累積。 |
| 7–8 | 安裝兩組既有 cable，實作 TL-In/TL-Out 設定檢查與 route meter；先本機 loopback fixture。 | 拓樸檢查拒絕相同 bus 回接；10 分鐘全雙工無自激。 |
| 9 | Zoom 與 Teams 分別手動選端點，跑預設及一個受控 audio-processing variant。 | 遠端測試者真的聽到 A 譯音，本機真的聽到 B 譯音；設定／版本被紀錄。 |
| 10 | 完整矩陣、雙語人工 review、延遲報告、driver/voice go-no-go 決策。 | 只在 Stage 0/1 gates 通過後才排產品實作；否則留下可重現失敗證據。 |

### Zoom + Teams 中↔英測試矩陣

| 平台 | ZH→EN 外送（本機 Mic → virtual mic） | EN→ZH 收聽（virtual speaker → 耳機） | EN→ZH 外送 | ZH→EN 收聽 | 全雙工／干擾 |
|---|---|---|---|---|---|
| Zoom | `Z-A1` | `Z-B1` | `Z-A2` | `Z-B2` | `Z-F`: A1+B1 同時、barge-in、兩位遠端重疊 |
| Teams | `T-A1` | `T-B1` | `T-A2` | `T-B2` | `T-F`: A1+B1 同時、barge-in、兩位遠端重疊 |

每格都至少覆蓋：

- 兩種端點格式（常見 44.1/48 kHz，mono/stereo）、耳機基線與一次喇叭風險測試；
- 譯音 only、原音 only、ducked mix；
- 平台預設處理與上節指定的一個受控處理變體；
- 短句、長句、姓名／數字／日期／專有名詞、台灣繁中／英文口音、code-switching；
- 良好網路與受控 jitter／重連；輸出遠端錄音、App trace、雙語評分與任何 policy/裝置列舉問題。

### 提議的 POC 驗收目標（產品目標，非供應商保證）

1. 在定義硬體、耳機、良好網路下，A 與 B 的 first translated audio 都達 **P50 ≤ 900 ms、P95 ≤ 1,600 ms**。
2. Zoom、Teams 的 `Z-F`／`T-F` 均可連續 10 分鐘雙向翻譯，沒有未預期的 A↔B 數位 feedback、無限 queue 或未揭露的音訊來源混入。
3. 雙語 reviewer 對預先定義 golden set 的「可理解且語意可接受」比例達專案先行同意的門檻（建議先訂 **≥90%**）；姓名／數字／日期另列失敗清單，不用平均分掩蓋。
4. App 發佈物、設定、log、crash report 均不含標準 OpenAI API key；App 明示正在把哪些音訊送到雲端。
5. 「聲音選擇」只有在 live session 對所需語言確實可用、可切換規則清楚且延遲不退化時才算通過；否則 POC 正式標為 deferred，不以假 UI 交付。

---

## 10. 實作前要問使用者的問題

1. 「中文」是台灣繁中／國語、簡中／普通話、粵語，還是都要？字幕和譯音的語體各自要什麼？
2. 來源／目標語言是否一定要由使用者強制選定，還是可以自動偵測來源、只選目標？這會影響目前 API 未文件化的 source-language 行為。
3. 「選擇輸出 voice」是 P0 還是可接受第一版只有服務輸出的預設聲音？需要幾種聲音、只是性別／風格，還是特定人物／自訂聲音？
4. 外送與收聽的預設要譯音 only、原音＋譯音，還是可由每次會議切換？混音時可接受多少延遲／雙語重疊？
5. 是否要求真正全雙工，或接受 push-to-talk／同時一人說話的會議禮儀？多人遠端重疊時預期 UX 是什麼？
6. 是否可要求耳機？若一定要喇叭，是否接受較高回音風險與後續 AEC scope？
7. 目標 Zoom／Teams 版本、Windows 版本／x64 或 ARM64、個人帳號或受管理企業 tenant 是什麼？使用者能否安裝 virtual cable／driver？
8. 是否允許使用第三方 cable 作 beta，還是首版就必須有自有已簽章 driver？Windows Update／企業軟體派送是否是需求？
9. 會議音訊送到 OpenAI 的告知、參與者同意、地域／ZDR、錄音／字幕保存以及資料保護責任由誰承擔？哪些法域／客戶合約適用？
10. 可接受的 p50/p95、每分鐘成本與每場會議用量上限是什麼？失去網路時要靜音、播原音，還是顯示字幕／錯誤？

---

## 主要原始來源書目

### OpenAI

- [Realtime translation guide](https://developers.openai.com/api/docs/guides/realtime-translation)
- [GPT-Realtime-Translate model and current price](https://developers.openai.com/api/docs/models/gpt-realtime-translate)
- [Realtime translation client events](https://developers.openai.com/api/reference/resources/realtime/translation-client-events)
- [Realtime translation server events](https://developers.openai.com/api/reference/resources/realtime/translation-server-events)
- [Realtime API with WebRTC](https://developers.openai.com/api/docs/guides/realtime-webrtc)
- [Realtime API with WebSocket](https://developers.openai.com/api/docs/guides/realtime-websocket)
- [Realtime and audio overview](https://developers.openai.com/api/docs/guides/realtime)
- [GPT-Live-Transcribe model](https://developers.openai.com/api/docs/models/gpt-live-transcribe)
- [GPT-Realtime-2.1 model](https://developers.openai.com/api/docs/models/gpt-realtime-2.1)
- [Realtime conversations / VAD / voice](https://developers.openai.com/api/docs/guides/realtime-conversations)
- [Managing Realtime costs](https://developers.openai.com/api/docs/guides/realtime-costs)
- [OpenAI API data controls](https://platform.openai.com/docs/models/default-usage-policies-by-endpoint)

### Microsoft Windows

- [WASAPI loopback recording](https://learn.microsoft.com/en-us/windows/win32/coreaudio/loopback-recording)
- [IAudioClient::GetMixFormat](https://learn.microsoft.com/en-us/windows/win32/api/audioclient/nf-audioclient-iaudioclient-getmixformat)
- [SysVAD Virtual Audio Device Driver Sample](https://learn.microsoft.com/en-us/samples/microsoft/windows-driver-samples/sysvad-virtual-audio-device-driver-sample/)
- [SysVAD upstream source / README](https://github.com/microsoft/Windows-driver-samples/blob/main/audio/sysvad/README.md)
- [From sample code to production driver](https://learn.microsoft.com/en-us/windows-hardware/drivers/gettingstarted/from-sample-code-to-production-driver)
- [Driver signing options](https://learn.microsoft.com/en-us/windows-hardware/drivers/dashboard/driver-signing-offerings)
- [Catalog files and digital signatures](https://learn.microsoft.com/en-us/windows-hardware/drivers/install/catalog-files)
- [Windows-driver-samples license](https://github.com/microsoft/Windows-driver-samples/blob/main/LICENSE)

### Zoom 與 Microsoft Teams

- [Zoom Workplace desktop/mobile settings](https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0060612)
- [Zoom speaker/microphone troubleshooting and switching](https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0060836)
- [Zoom advanced audio settings](https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0066398)
- [Zoom audio echo / feedback](https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0061720)
- [Teams manage call device settings](https://support.microsoft.com/en-us/teams/calls-devices/manage-your-call-settings-in-microsoft-teams)
- [Teams meeting audio settings](https://support.microsoft.com/en-us/teams/meetings/manage-audio-settings-in-microsoft-teams-meetings)
- [Teams noise suppression](https://support.microsoft.com/en-us/teams/meetings/reduce-background-noise-in-microsoft-teams-meetings)
- [Teams high-fidelity music mode](https://support.microsoft.com/en-us/teams/notifications-settings/use-high-fidelity-music-mode-to-play-music-in-microsoft-teams)

## Facts vs. estimates／assumptions

| 類型 | 可當作已驗證事實 | 不能當作事實、必須在 POC 驗證的項目 |
|---|---|---|
| API | `gpt-realtime-translate`、專用端點、連續翻譯、每方向一 session、WebSocket 24 kHz PCM16 mono／200 ms frame、串流譯音 delta、目標語言欄位與目前價格，均由上述 OpenAI 原始文件支持。 | 中文的精確語體／語言碼支援、來源語言 selector 是否可控制 model、專用端點可選 voice、原生 Windows WebRTC 實作細節、WebSocket client-secret 認證契約。 |
| 延遲 | WebSocket 200 ms frame 條件及「官方未提供本案毫秒 SLA」。 | 900/1,600 ms、各子區段預算、WebRTC 是否較快、網路／模型 p95、任何 Zoom／Teams 遠端收聽延遲；全是產品目標或量測結果。 |
| Windows | WASAPI shared mix format、loopback 的 shared-only 限制、SysVAD 的 WaveRT/sample 性質、driver signing 選項。 | 任意 virtual cable 在每台機器／每個 tenant 都會被 Zoom／Teams 列出；兩對 cable 的穩定性／延遲；自製 driver 的 HLK 成功與商業散布成本。 |
| 產品／法務 | OpenAI API 預設不訓練資料與預設 abuse-monitoring retention 描述；Zoom／Teams 有可選的裝置與處理設定。 | 與會者同意、錄音告知、資料地域／ZDR 對 translation 子端點的適用性、企業政策、第三方 cable 授權、聲音授權，均需產品、法務、帳戶／租戶層面的明確決策。 |
