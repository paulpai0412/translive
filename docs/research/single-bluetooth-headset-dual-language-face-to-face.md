# 單副藍牙 TWS：雙人面對面、左右耳不同語言

- **問題**：A 戴左耳只聽語言 A、B 戴右耳只聽語言 B，Translive 是否能只用同一副真無線耳機？
- **研究範圍與方法**：檢視目前 renderer 的雙 session 拓撲，並只採用規格、Bluetooth SIG、Microsoft、Chromium 原始碼及廠商第一方資料。除另註外，所有網頁於 **2026-08-30** 存取。
- **結論（先行）**：**有條件可行，但不能把「一副」當成對所有耳機／所有 Windows 的保證。** 當 Windows 將這副耳機公開為一個可用的 **stereo A2DP output endpoint**、未使用該耳機麥克風、OS/耳機未把聲道混成 mono，Translive 可把兩條各自 mono 的翻譯流合成 L/R，送往同一 sink；A/B 各戴一耳即可私密收聽各自目標語言。這只證明**輸出**可行。一般 Classic Bluetooth TWS 不會向 Web API 公開「左、右兩條獨立麥克風」，所以雙人輸入必須改用獨立於耳機的麥克風，且重疊說話不能可靠地分人。若需耳機麥克風、端點非立體聲、啟用 mono、或實測有串音／摘耳後 downmix，則本方案 **no-go**；改用兩副耳機（搭配適當輸入）或手機／筆電喇叭。

## 1. 現況：Translive 的雙 session 音訊拓撲

`src/renderer-entry.js#createRealtimePeer` 對每個 direction 建立各自的 `getUserMedia({deviceId: source.id})`、`RTCPeerConnection`、資料通道和隱藏 `<audio>`；遠端 track 到達時直接設給該 `<audio>.srcObject`，再個別 `audio.setSinkId(sink.id)`、`play()`。`startTranslation()` 會依 meeting mode 建立 `tx` 與 `rx` 兩個 peer。因此目前是「兩條遠端輸出各自播放、可各選 sink」，**不是**一個明確的 L/R 總線；兩個 peer 若同指一個耳機，沒有程式碼保證 tx 只在左、rx 只在右。[本地原始碼：`src/renderer-entry.js#createRealtimePeer`，本次檢視 2026-08-30]

這是最小改動的切點：保留兩個即時翻譯 session／各自 mono 輸出，不再讓各 session 的 `<audio>` 各自直出；改為一個共同的 renderer audio graph 和一個 Bluetooth sink。這不是要求服務端改成 stereo，也不應把語言混音後再送出。

## 2. 技術可行性：一個 stereo render endpoint 的 L/R 輸出

### 已驗證的 Web 平台能力

- W3C Web Audio 的 `ChannelMergerNode` 是「把多個 audio streams 的 channels 合成一個 audio stream」的節點；`createChannelMerger(numberOfInputs)` 可建立至少兩個輸入，且 merger 的 channel-count mode 是 explicit。故將 **A 的 mono source 接 input 0、B 的 mono source 接 input 1** 是有規格依據的離散 L/R 建圖方式，而非依賴自動 pan／mix。[W3C Web Audio API 1.1 §1.5、§1.17、§1.20，https://www.w3.org/TR/webaudio/ ，2026-08-30]
- `createMediaStreamDestination()` 會建立 `MediaStreamAudioDestinationNode`，其目的地是可送給遠端 peer 的 `MediaStream`；規格也將其描述為送出經處理音訊的 `MediaStream` destination。故可把 merger 連到它，再將 `destination.stream` 指派給**唯一** `<audio>` element；這是本案要求的 bridge，並非把兩個 HTML audio element 碰巧選同一 sink。[W3C Web Audio API 1.1，https://www.w3.org/TR/webaudio/ ，2026-08-30]
- `HTMLMediaElement.setSinkId(deviceId)` 的規格語義是選擇該 element 輸出的 audio device；非預設裝置需要 `speaker-selection` 權限／允許，並可能失敗。應先以使用者動作呼叫 `selectAudioOutput()`（如 Electron/Chromium runtime 支援），或處理 `setSinkId` 的 `NotAllowedError`、`NotFoundError` 等失敗。[W3C Audio Output Devices API，https://www.w3.org/TR/audio-output/ ，2026-08-30]
- Chromium 官方文件說明 Chrome 110 起 `AudioContext.setSinkId()` 可直接將 Web Audio 導往已允許的 Bluetooth headset；但 Translive 現有做法可維持單一 `<audio>.setSinkId()`，不必同時讓 AudioContext 與 element 競爭選 sink。[Chrome for Developers，https://developer.chrome.com/blog/audiocontext-setsinkid ，2026-08-30]

### 建議的最小輸出架構（尚未實作）

```text
TX 翻譯的 remote MediaStream ── MediaStreamAudioSourceNode (確保 mono) ─┐
                                                                       ├─ ChannelMergerNode(2)
RX 翻譯的 remote MediaStream ── MediaStreamAudioSourceNode (確保 mono) ─┘
       input 0 = 左 / 語言 A；input 1 = 右 / 語言 B
                   → MediaStreamAudioDestinationNode
                   → 一個 <audio autoplay>.srcObject = destination.stream
                   → await audio.setSinkId(stereoBluetoothEndpointId)
```

實作時每一個 remote stream 只接 merger 的指定 input（`source.connect(merger, 0, 0|1)`），不要用兩個 `StereoPannerNode` 後再進同一混音輸入，以免 implicit down/up-mix 使聲道語義不清。每條翻譯在進圖前應確認／轉成 mono；**只要任一 source 已是 stereo、OS output 是 mono、或 accessibility 將它 downmix，語言隔離即不成立**。Web Audio 規格明定 `speakers` interpretation 會進行 up/down-mix，故需以兩輸入 merger 明確建離散雙聲道，並以實測驗證。[W3C Web Audio API 1.1，https://www.w3.org/TR/webaudio/ ，2026-08-30]

`setSinkId` 是 feature/permission 邊界，不能假設 Electron 版本一定具備。Chromium upstream 的 `AudioContext::setSinkId` 實作會對未授權、找不到、timeout、不可用的裝置拒絕 promise，並在改 sink 時停止再重啟 rendering；此為必須捕捉並顯示可恢復錯誤的第一方行為依據。[Chromium source `audio_context.cc`，https://chromium.googlesource.com/chromium/src/third_party/%2B/refs/heads/main/blink/renderer/modules/webaudio/audio_context.cc ，2026-08-30]

**推論／範圍界線**：Web Audio 能產生 L/R 並指定一個 endpoint，並不保證 endpoint 最後用立體聲物理播放；耳機韌體、Bluetooth profile、Windows format 與 accessibility 都在 Web graph 之外。因此此節是「app 端可建圖」，不是硬體相容性承諾。

## 3. Windows 與 Bluetooth profile：決定是否能保留 L/R

### Classic Bluetooth：A2DP 與 HFP 的硬性取捨

- Bluetooth SIG 的 A2DP 規格定義高品質音訊分發，明列支援 mono、stereo 或 multi-channel，典型案例是 stereo player 對 headphones/speakers 的串流；這足以作為單一 stereo endpoint 載送兩個不同 channel 的協定層前提。[Bluetooth SIG A2DP 1.4.1 §1.1，https://www.bluetooth.com/specifications/specs/html/?src=a2dp_v1-4-1_1752513648/A2DP_v1.4.1/out/en/index-en.html ，2026-08-30]
- Microsoft 的 Windows driver 文件明定 Classic Audio：A2DP 是 host→device 的高品質 stereo playback；若使用耳機裝置的 microphone capture，必須改用 HFP。HFP 是並行的 **monaural** capture 與 **monaural** playback。[Microsoft，https://learn.microsoft.com/en-us/windows-hardware/drivers/bluetooth/bluetooth-classic-audio ，2026-08-30]
- Windows 10 配對 Classic device 後，A2DP 會有 `{Device} Stereo` output，而 HFP 有 `{Device} Hands-Free` input/output。只要應用開啟 hands-free microphone 或輸出至 hands-free，裝置切到 HFP，送往 Stereo output 的音訊會被丟棄。[同上 Microsoft Bluetooth Classic Audio，2026-08-30]
- Windows 11 將支援 HFP 的 Classic device 統一成一個 output、input endpoint；只要 app 開 input 或建立 Communications category playback，就選 HFP，其他 playback 才選 A2DP。切換是自動的，HFP 時其他 48 kHz 播放也會被 resample 成目前 profile。[同上 Microsoft Bluetooth Classic Audio，2026-08-30]

**對 Translive 的結果**：Classic 模式下，單副方案的必要條件是「Bluetooth 耳機只作 output（A2DP）」；兩個 translation session 的 `getUserMedia` **不得**選該耳機 mic。這也解釋為何「用同副 TWS 同時收兩人語音、又要 L/R 私密輸出」不是 P0 可承諾的路徑。

### Windows 11 LE Audio：不是所有 BT 5.x／所有耳機的例外

- Microsoft 要求 Windows 11 LE Audio 同時有：Windows 11 22H2 以上、相容 Bluetooth LE 與 audio codec、OEM 提供的 LE Audio-capable Bluetooth radio 和 audio codec drivers；耳機本身也要宣告 Bluetooth LE Audio 或 TMAP。僅標示「Bluetooth LE」不夠，Windows 10 與 Windows 11 21H2 不支援。設定中沒有 **Use LE Audio when available** 即表示目前硬體／driver 尚不支援。[Microsoft，https://support.microsoft.com/en-us/windows/check-if-a-windows-11-device-supports-bluetooth-low-energy-audio-2b79c085-0353-4467-8306-ebb2657a91de ，2026-08-30]
- Microsoft 也明定：LE Audio communications（TMAP/HAP）下，**部分** Windows 11 PC 可在 mic 使用中維持 stereo playback；若 OS、PC Bluetooth/audio subsystem 不支援 stereo，或使用者選了 1-channel mode，mic 使用時 playback 仍是 mono。它要求 app 查實際 channel count／format，並指出舊於 Windows build 26100.4484 的 `GetMixFormat` 對 LE Audio output channel count 不可靠。[Microsoft，https://learn.microsoft.com/en-us/windows/win32/coreaudio/communications-audio-format-capabilities ，2026-08-30]
- Bluetooth SIG 將 LE Audio 建立於 LE Isochronous Channels 與 Generic Audio Framework；TMAP 是為 telephony/media 的互通使用案例。這是協定能力，不是每副 TWS 必須提供兩條可由 app 選用的 mic channel。[Bluetooth SIG，https://www.bluetooth.com/learn-about-bluetooth/feature-enhancements/le-audio/le-audio-specifications/ ，2026-08-30]

**產品決策**：LE Audio 可列為「通過實測才啟用耳機 mic 的 experimental capability」，不能拿來放寬 Classic 預設。即使在合格的 24H2 系統上，也必須實測本款 PC + driver + 耳機於 mic active 的**實際 output channel count 與 L/R leakage**；不得因 OS 名稱或 Bluetooth 版本宣稱通用雙向 stereo。

## 4. TWS 左右耳的現實限制與 input capture

### 左右耳不是兩個可自由路由的 OS 音訊裝置

從標準和 Windows 文件可驗證的是：Windows 把 remote Bluetooth audio device 作為 input 和／或 playback endpoint，Classic Windows 11 更將 A2DP/HFP 統一為一 input、一 output endpoint；文件**沒有**承諾將一副 TWS 的 left/right 公開成兩個可獨立選擇／配對的 `MediaDeviceInfo` microphones。[Microsoft Bluetooth Classic Audio，https://learn.microsoft.com/en-us/windows-hardware/drivers/bluetooth/bluetooth-classic-audio ，2026-08-30]

因此下列不可泛化，也不可作為 Translive acceptance：左、右可各自獨立配對、可取兩條獨立 microphone stream、哪一耳作 primary、摘一耳後是否仍立體聲、入耳偵測後是否 pause/downmix、或 charging/case reconnect 時是否保持 channel mapping。它們是耳機韌體／產品設計問題，必須每個型號實測。

具體但**不泛化**的第一方例子：Google 的 Pixel Buds 規格顯示某些型號「每個 earbud」都有 Bluetooth、speaker、兩或三顆 microphone，以及 IR proximity sensor 供 in-ear detection 自動 play/pause。這證明「每耳有硬體 mic／感測器」可能存在，卻沒有承諾 Windows/Web API 會把它們公開為兩個獨立 capture stream。[Google Pixel Buds specs，https://support.google.com/googlepixelbuds/answer/7544332 ，2026-08-30]

Windows 的 mono 也可能是使用者選擇：Microsoft 的 communications 文件明說使用者手動設為 1-channel 時 LE Audio mic active 的 playback 會 mono。對 Classic HFP，mono 則是 profile 本身結果。[Microsoft communications formats，https://learn.microsoft.com/en-us/windows/win32/coreaudio/communications-audio-format-capabilities ，2026-08-30]

### 面對面輸入：一副耳機通常不能得到兩個人各自乾淨的 mic stream

**結論**：不把「兩耳各有 mic」誤讀成「可取得兩條獨立 stream」。現在 `createRealtimePeer` 確實為 tx/rx 分別要求一個 input device，但若兩者選同一 Bluetooth headset endpoint，這至多是重複開同一 OS capture endpoint；它不會依佩戴者把訊號自動分離。本 repo 尚無 speaker diarization／source separation，不能在兩人重疊說話時把一條共同 mic 錄音可靠拆成 A、B。[本地原始碼：`src/renderer-entry.js#createRealtimePeer`，本次檢視 2026-08-30]

P0 的最小、可靠輸入選項（從小到大）：

1. **筆電／手機內建 mic 一支 + turn-taking / push-to-talk**：最少硬體，適合安靜近距離；UI 顯示「輪流說」，一次只讓對應 direction 送音。重疊語音只能標示／丟棄／重試，不能宣稱可分人。
2. **兩支有線 USB／lavalier mic，各自固定 deviceId**：每人一支，維持耳機輸出在 A2DP；這是需要雙向同時輸入時的最小可靠配置。應將 mic A 僅接 language-A session，mic B 僅接 language-B session。
3. **兩副耳機**：僅在必須讓每人各自有 private output、某一副不能保留 stereo、或使用者不接受共享耳塞時採用；若又要求雙人各自 mic，仍需驗證每副的 Bluetooth mode，不可假定 Classic HFP 不降質／不 mono。

## 5. 專用翻譯耳機的「一人一耳」先例

Timekettle 的官方 W4 Pro 說明其 One-on-One Mode 為一人各戴一個 earbud 的 two-way real-time translation，且該產品設計含每支 3 mics／雙托盤 charging case。這是市場上「一人一耳」可做成產品的第一方先例。[Timekettle 官方，https://www.timekettle.co/en-eu/blogs/tips-and-tricks/all-about-w4-pro-interpreter ，2026-08-30]

這**不能**推導出 Translive + 任意 consumer TWS + 任意 Windows 必定可行：該廠商控制耳機韌體、行動 app、模式和 mic 策略；Translive 使用 Windows/Electron/Web Audio，且不能取得其專有 route／pairing 行為。它只能支持 UX 可行性，不可當相容性／延遲／聲道隔離保證。

## 6. Translive P0 方案、go/no-go 與 fallback

### P0 scope（不在本研究中實作）

1. 新增「共享單副耳機（實驗性）」route profile，僅接受一個被列舉且使用者選定的 Bluetooth **audiooutput** sink；UI 固定顯示 **A＝左／語言 A、B＝右／語言 B**，開始前要求兩人確認左右佩戴。
2. 保留兩個翻譯 session 與每條獨立 mono remote output；替換其直出播放為 §2 的一個 merger/destination/`<audio>` sink。每條 mute 必須是獨立 gain/mute，不得 mute 共同 element。
3. 預設 input 選非 Bluetooth output 的筆電／USB mic；若偵測 input/output 是同一 Classic headset/group，阻止開始並明示「會切 HFP／mono」。Windows 11 的 unified endpoint 特別需要這個 guard。
4. 畫面必有醒目的 profile/mode（A2DP 或經驗證 LE Audio）、左右測音、每耳音量、連線／電量／單耳摘除警告與切 fallback 的按鈕；裝置更換／`devicechange`／`setSinkId` rejection 時停止輸出而非默默改到 speaker。

### Go / no-go 判斷

**Go（限此設備組合）**：
- 兩段測音在 A 左耳、B 右耳，對方耳與反向 channel 都聽不到可辨語音；
- Windows A2DP 未被耳機 mic／Communications 切為 HFP；或通過指定 LE Audio 組合的 mic-active stereo 測試；
- mono accessibility 關閉，摘一耳／重連後仍驗證 mapping；
- 每人輸入路徑已選妥：輪流說的一支外部 mic，或兩支獨立外部 mic；
- 斷線或驗證失敗有安全 fallback，不會把機密翻譯悄悄送到房間喇叭。

**No-go（改 fallback）**：任一條件不成立、OS 報 mono/通訊 profile、右/左 leakage 可辨、音訊被自動 downmix、兩人同時說而只有共同 mic、或裝置對單耳配戴會 pause/改 mapping。fallback 順序：**兩副耳機 + 各自經驗證路由**；若不需私密性則使用**手機／筆電喇叭**及文字字幕；必要時僅提供輪流說 PTT。

## 7. P0 實測清單（不猜測毫秒數）

每一組以「Windows build、PC Bluetooth/audio driver 版本、耳機 model/firmware、profile、codec（若 OS 可見）、input devices」記錄。不要在未量測前寫任何延遲毫秒數。

- [ ] **Windows 10 Classic**：A2DP stereo output；耳機 mic 開／關時確認 HFP 切換和 stereo stream 是否被丟棄（Microsoft 明定該行為）。
- [ ] **Windows 11 Classic**：unified endpoint；在開／關耳機 mic、Communications stream 下確認 A2DP↔HFP 和實際 channel count。
- [ ] **Windows 11 LE Audio**：僅在設定有 `Use LE Audio when available`、耳機宣告 LE Audio/TMAP、driver 合格時測；分別測 mic idle 和 mic active。不能把通過者外推到另一 PC／耳機。
- [ ] **L/R isolation**：以頻率不同、語句不同的 A/B test tone 與真人語音，左右各自錄／聽測；量化或至少以盲測記錄 channel leakage。禁用所有 mono audio setting 後測一次，再啟用 mono 確認方案會偵測／拒絕。
- [ ] **單耳／入耳狀態**：分別摘左、摘右、放回／重新戴上；確認 pause、auto-mono、primary-ear 變更、channel mapping、音量是否改變。
- [ ] **可靠性**：低電量、case 收納、Bluetooth disconnect/reconnect、Windows default device 改變、`devicechange`；確認不會 silent fallback 到 speakers，且可復原後重做左右測音。
- [ ] **輸入**：筆電單 mic 的輪流說、兩支 USB/lavalier 的各自 capture、誤選 Bluetooth mic 的 guard；再測兩人重疊，結果必須標記為不支援／降級，而非誤稱雙人分流成功。
- [ ] **端到端體感延遲**：以時間戳／錄音測量「說話→目標耳朵」每種組合的分布及測法；報告測得值、環境和版本，**不從資料表臆測固定 ms**。

## 8. UX、衛生與安全

- 耳塞是個人接觸物。初次使用明確告知「共享耳塞」並提供可清潔／可替換耳塞、酒精／清潔指引連結與「改用兩副／喇叭」選項；不要把陌生人共享當預設。
- 開始畫面做成左右兩張大卡：`A（左耳）聽：繁中`、`B（右耳）聽：English`（語言依實際設定），附 1–2 秒可重播的左右測音和「戴反了」交換按鈕。不要只用國旗或縮寫。
- 連線期間永久顯示目前 route、output profile、耳機 mic 是否被禁止、兩個 input device、L/R health。任何 channel isolation 失敗、mono、端點切換都要停止私密模式，明確告知而非讓中文／英文串音。
- 音量預設保守、各耳獨立調整、可快速 mute；面對面環境仍需讓使用者聽見安全提示／周遭聲音。翻譯文字／音訊涉及私密對話，capture consent 和錄音留存政策必須沿用／補足現有 consent UI。

## 9. 未能以主要來源驗證／不得寫成保證的事項

1. 任意特定 TWS 是否在 Windows 公開一個 stereo endpoint、各耳是否獨立 pairing／mic、單耳摘除後行為、主從連線與 firmware downmix：無跨廠商規格保證，逐款實測。
2. Electron 目前打包的 Chromium 版本是否支援所需的 `AudioContext.setSinkId`／`selectAudioOutput`：需以該 runtime feature detection 測，不應僅以 Chrome 110 文件推定。
3. 雙人同時說話時，一支共同筆電 mic 能否可靠分離說話者：本 repo 目前程式碼沒有提供這種能力；本研究未找到可將它視為既有能力的第一方來源。
4. 端到端 latency：未量測；任何固定毫秒數都不應加入規格。

## 建議的 acceptance / validation 條件

「一副耳機完成」的可接受定義應改為：**對通過 P0 matrix 的指定 Windows + driver + 耳機組合，在外部／分離 input 或輪流說限制下，兩個 mono 翻譯能以一個 stereo Bluetooth output endpoint 映射左右耳，且不發生可辨語言串音。** 它不是「所有 TWS 都可同時提供兩個獨立 mic」。

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "只產出本研究報告；範圍限定於單副藍牙耳機雙語面對面可行性、既有拓撲與 P0 驗證。"
    },
    {
      "id": "criterion-2",
      "status": "satisfied",
      "evidence": "每項實質平台／協定主張均鄰接 Bluetooth SIG、Microsoft、W3C、Chromium 或廠商第一方 URL 與存取日；含可重複的 P0 matrix 與 go/no-go。"
    }
  ],
  "changedFiles": [
    "docs/research/single-bluetooth-headset-dual-language-face-to-face.md"
  ],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "read src/renderer-entry.js (createRealtimePeer and startup call path)",
      "result": "passed",
      "summary": "確認現有雙 peer、各自 getUserMedia 與各自 audio.setSinkId 拓撲。"
    },
    {
      "command": "primary-source fetch/check: W3C, Bluetooth SIG, Microsoft, Chromium, Google, Timekettle",
      "result": "passed",
      "summary": "取得並交叉檢查所引用的第一方規格、官方文件及 upstream source。"
    }
  ],
  "validationOutput": [
    "研究報告包含 Windows 10/11、Classic A2DP/HFP、LE Audio 前提、TWS/input 限制、最小架構、P0 matrix、fallback 與 UX/衛生要求。"
  ],
  "residualRisks": [
    "尚未對任何實體 PC、driver、耳機組合執行 P0 matrix；相容性不可泛化。",
    "Electron runtime feature support 與耳機 firmware/單耳行為需裝置實測。",
    "一支共同 mic 的重疊說話不可保證分人。"
  ],
  "noStagedFiles": true,
  "diffSummary": "新增一份繁體中文、以主要來源支撐的單副 TWS 雙語面對面研究報告。",
  "reviewFindings": [
    "no blockers in research artifact; implementation must gate the feature on the P0 go/no-go checks."
  ],
  "manualNotes": "輸出路徑由子代理執行環境覆寫；正式整合時請將此唯一檔案置於 repo docs/research/ 指定路徑，且不要覆蓋其他人工作樹變更。"
}
```