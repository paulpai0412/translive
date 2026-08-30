# GPT Live 後即時轉換為使用者音色：可行性與最小落地建議

- **問題：**Translive 現以 Codex `gpt-live-1-codex`／WebRTC 輸出合成語音；在沒有獨立 GPU、只有 CPU 與可能的 Intel／AMD iGPU 的 Windows 機器上，如何把該輸出即時轉為「使用者自己的音色」？
- **查證／來源存取日：**2026-08-30。
- **讀過的本機脈絡：**`docs/research/codex-gpt-live-implementation.md`、`docs/research/windows-realtime-translation-architecture.md`、`docs/specs/2026-08-28_phase1-dual-channel-realtime-translation-poc.md`、`src/phase-one-controller.js`、`src/dual-channel-run.js`、`src/renderer-entry.js`。
- **判讀記號：**「已驗證」只指緊鄰的一手文件／上游原始碼；「工程建議」是依該事實對 Translive 作出的設計推論；「未驗證」不得當成產品承諾。

## 結論先行

**目前最合適的路徑是：保留現有 GPT Live PoC 時，在每一條 GPT Live *輸出* WebRTC track 後面加一個本機 RVC sidecar；先以官方 RVC 的 CPU 路徑量測，再嘗試 Windows DirectML。**它只改變播放鏈最後一段、不把音訊再送回 OpenAI、不新增虛擬音訊 driver，也能在轉換逾時時立即退回原本 GPT Live 內建聲音。

這不是說 OpenAI 沒有 Custom Voices：OpenAI 已文件化「Custom Voices 可用於 Realtime API」，但僅限合資格組織，且公開範例是 `gpt-realtime-2` 的標準 Realtime session。【[OpenAI Text-to-Speech / Custom Voices](https://developers.openai.com/api/docs/guides/text-to-speech)（存取：2026-08-30）】Translive 現在走的是實驗性的 Codex app-server GPT Live V3；其釘選上游 client `RealtimeVoice` 是封閉的內建 voice enum，現有 client 沒有傳送 `voice_…` custom ID 的型別路徑。【[Codex `RealtimeVoice` 原始碼（固定 SHA）](https://github.com/openai/codex/blob/7625343977154efed8c0dadba956374992a1580b/codex-rs/protocol/src/protocol.rs#L320-L360)（存取：2026-08-30）】因此：

| 決策 | 判斷 | 現在要做的事 |
| --- | --- | --- |
| OpenAI 原生 custom voice | **條件式最佳**：若 OpenAI 讓組織啟用，且產品可改走有文件的 Platform Realtime API，便省掉一整段本機 VC 延遲與模型散布。 | 先向 OpenAI sales/account team 取得「該 organization、目標 Realtime model、商用情境」的書面確認；不要把它假定為現有 GPT Live entitlement。 |
| 現有 Codex GPT Live V3 | **不能把公開 Custom Voices 文件當成已支援證明。**app-server `thread/realtime/start` 也標為 experimental。 | 不繞過 client enum、不要猜未文件化 `/v1/live` 可接受 custom ID。保持為 local post-processing。 |
| 無 dGPU 的近期 PoC | **RVC 官方主專案**是比較符合條件的候選：有 real-time GUI、CPU／AMD／Intel dependency 路徑，Windows 可用 DirectML，程式碼 MIT。 | 先測 CPU，再測實際 iGPU 的 DirectML；未過 gate 一律 raw GPT 音訊 fallback。 |
| OpenVoice／Seed-VC／w-okada | 不適合作為本案的首個產品核心。 | OpenVoice 沒有官方 streaming realtime contract；Seed-VC 官方強烈建議 GPU 且 repo 已 archived；w-okada 適合作為手動比較工具，不應先嵌入／打包。 |

> **刻意不做：**不先建 custom virtual-audio driver、不建新的 STT→翻譯→TTS 備援鏈、不 fork RVC、不把模型轉 ONNX/OpenVINO 當 P0；那些都不能回答「此 iGPU 能否跟上 live 音訊」這個根本問題。

---

## 1. 現有 Translive／GPT Live 的事實與邊界

### 1.1 本機程式目前的輸出位置

本機 `src/phase-one-controller.js` 對每個方向以 `version: "v3"`、`outputModality: "audio"`、`transport: { type: "webrtc", … }` 啟動 `gpt-live-1-codex`；`src/renderer-entry.js#createRealtimePeer` 收到 remote `track` 後直接做：

```text
remote MediaStream → <audio>.srcObject → audio.setSinkId(既有 TX/RX sink) → play()
```

因此，**唯一需要插入的位置是 remote GPT 音訊 track 與既有 sink 之間**；不應動輸入 mic、兩個 Codex thread、WebRTC SDP、TX/RX virtual-cable 拓撲，亦不應把已轉換的音訊回餵到 GPT Live。

Codex 的 V3 Frameless WebSocket parser 對 `output_audio.delta` 目前硬編碼為 24 kHz／mono；但 Translive 實際使用 WebRTC remote track，WebRTC 媒體 codec／實際 `AudioContext` rate 是 SDP／runtime 協商結果，並沒有同一份公開 GPT Live codec contract。【[V3 WebSocket `output_audio.delta` parser](https://github.com/openai/codex/blob/7625343977154efed8c0dadba956374992a1580b/codex-rs/codex-api/src/endpoint/realtime_websocket/protocol_frameless_bidi.rs)（存取：2026-08-30）】**工程含義：不要把 WebRTC track 硬當 24 kHz PCM。**啟動時讀取真實 track／`AudioContext.sampleRate`／channel 數並記錄，只有在 VC model 邊界才重採樣。

### 1.2 為何現有 GPT Live 不能直接宣稱支援 OpenAI Custom Voice

- OpenAI 公開文件明載 Custom Voices 可用於 Text-to-Speech、Realtime 與 Chat Completions audio output，並示範公開 Realtime `audio.output.voice: { id: "voice_123abc" }`。【[OpenAI Text-to-Speech / Custom Voices](https://developers.openai.com/api/docs/guides/text-to-speech)（存取：2026-08-30）】
- 同一文件的 Realtime 示例 model 是 `gpt-realtime-2`，不是 `gpt-live-1-codex`。【[同一 OpenAI Realtime custom voice 示例](https://developers.openai.com/api/docs/guides/text-to-speech)（存取：2026-08-30）】
- Codex 固定 SHA 的 protocol 將 `RealtimeVoice` 定義成 Alloy、Cove、Marin 等列舉值，而不是 string／voice object；該 client 對目前 Translive 所走的路徑沒有 custom ID 參數。【[Codex `RealtimeVoice` 原始碼（固定 SHA）](https://github.com/openai/codex/blob/7625343977154efed8c0dadba956374992a1580b/codex-rs/protocol/src/protocol.rs#L320-L360)（存取：2026-08-30）】
- OpenAI 的 Codex app-server README 將 `thread/realtime/start` 標成 experimental；WebSocket listener 也明示 experimental / unsupported。【[Codex app-server README（固定 SHA）](https://github.com/openai/codex/blob/7625343977154efed8c0dadba956374992a1580b/codex-rs/app-server/README.md)（存取：2026-08-30）】

**結論（已驗證範圍）：**公開 Custom Voices 的存在，不能證明目前 GPT Live V3 session 可用，也不能證明現有 Codex client 可送出它。這不是「上游永遠不支援」的負面證明；而是 production／PoC 都不應以未驗證能力作為依賴。

---

## 2. OpenAI 官方 Custom Voices：可用性、資格、同意與限制

| 已驗證項目 | 影響 |
| --- | --- |
| Custom Voice 僅對 **eligible customers** 開放；需聯絡 sales，組織啟用後才會出現 Voices 管理頁。 | 先做 entitlement gate；不可把一般 API key、ChatGPT login 或 GPT Live 成功連線視為資格。 【[OpenAI Custom Voices](https://developers.openai.com/api/docs/guides/text-to-speech)（存取：2026-08-30）】 |
| 建立需兩段**分開**的錄音：聲音所有者朗讀指定句的 consent recording，及 model 用來模仿的 sample recording；sample 必須與 consent 是同一位聲音。 | 不能只上傳任意會議錄音／名人片段。OpenAI 的 consent 句必須完全吻合，偏離會失敗。 【[OpenAI Custom Voices consent flow](https://developers.openai.com/api/docs/guides/text-to-speech)（存取：2026-08-30）】 |
| 目前每 organization 最多 20 個 voices；sample 最長 30 秒；可接受 `mpeg`、`wav`、`ogg`、`aac`、`flac`、`webm`、`mp4`。 | 這是 OpenAI 原生路徑的硬限制，不是 RVC 的訓練需求。 【[OpenAI Custom Voices limits](https://developers.openai.com/api/docs/guides/text-to-speech)（存取：2026-08-30）】 |
| API flow 是先 `POST /v1/audio/voice_consents`，再以 consent ID 對 `POST /v1/audio/voices` 建 voice；使用時把 custom voice ID 放進語音生成／公開 Realtime session 的 `voice` 欄位。 | key 必須由可信任 backend 持有；不要在 Electron renderer 建 voice 或暴露管理型 key。 【[OpenAI Custom Voices API examples](https://developers.openai.com/api/docs/guides/text-to-speech)（存取：2026-08-30）】 |
| 公開 Realtime 文件指出：session 一旦已輸出過 audio，就不能再改 output voice。 | 聲音切換要在建立 session 前選定；切換時重建 session／切到下一段，不做「播放中瞬切」。 【[OpenAI Realtime conversations / voice options](https://developers.openai.com/api/docs/guides/realtime-conversations)（存取：2026-08-30）】 |
| OpenAI RBAC 有 Voices 的 Create／Read 權限。 | 將建立、讀取及使用 voice 的權限以最小權限分開；不讓一般操作員擁有 voice-admin 身分。 【[OpenAI RBAC permissions](https://developers.openai.com/api/docs/guides/rbac)（存取：2026-08-30）】 |

### 原生路徑的正確決策門檻

只有同時滿足下列三件事，才可把 OpenAI Custom Voice 視為**取代本機 VC**的候選：

1. 組織已實際開通 Custom Voices；
2. OpenAI 書面確認欲用的**公開** API／model 可接受該 voice ID、支援商用情境；
3. 產品同意由 Codex GPT Live V3 遷到該公開 Realtime surface，並重新驗證翻譯連續性、成本、延遲與資料治理。

若任一未過，這不是「再試一個未文件化 header」的問題；應走本機 post-VC。原生路徑雖然最小，但它是**產品／資格決策**，不是目前 renderer 的小修。

---

## 3. 正確的串流架構、格式與延遲控制

### 3.1 建議的最小資料流（工程建議）

```text
每一個既有 TX 或 RX Codex WebRTC PeerConnection
  remote GPT Live MediaStreamTrack
            │
            ├── raw timestamped path ───────────────────────────────────┐
            │                                                           │
            ▼                                                           │
  Web Audio MediaStream/Track source                                    │
            │                                                           │
  AudioWorklet：只做 frame copy、seq/timestamp、bounded queue             │
            │                                                           │
  local-only RVC sidecar（每方向獨立 state；CPU 或 DirectML）              │
            │  input/output: 固定 frame 的 mono float PCM               │
            ▼                                                           │
  output AudioWorklet → MediaStreamAudioDestinationNode → <audio>      │
            │                                                           │
            └────既有 audio.setSinkId(TX Cable-A 或 RX headphones)───────┘

deadline miss / process crash / model not ready
  → flush converted queue，在 frame boundary 切到同一 timestamp 的 raw path
  → 顯示「自訂音色暫停，正在播放原 GPT 音色」；不得同時混播兩條音訊
```

W3C Web Audio 規格明確允許將 remote peer 的 `MediaStream`／`MediaStreamTrack` 作為 `MediaStreamAudioSourceNode`／`MediaStreamTrackAudioSourceNode`，以 `AudioWorklet` 作自訂處理，並由 `MediaStreamAudioDestinationNode` 輸出 processed `MediaStream`。【[Web Audio API 1.1：remote peer、source、destination、AudioWorklet](https://www.w3.org/TR/webaudio/)（存取：2026-08-30）】WebRTC 規格也規定 remote media 會透過 peer connection 的 `track` event 暴露給應用程式。【[WebRTC specification：remote `MediaStreamTrack`](https://www.w3.org/TR/webrtc/)（存取：2026-08-30）】

**這是後處理，不是第二個 Realtime session：**GPT Live 的 WebRTC connection 維持原樣；converted audio 僅接到既有 TX Cable-A／RX 耳機 sink。這保留目前兩個 thread、兩條獨立 bus、反饋防護和各自 mute 的設計。

### 3.2 不可省略的串流規則

1. **每個方向一個 converter state。**TX、RX 可同用同一個「目標聲音」model artifact，但不能共用一個帶 context／SOLA／pitch cache 的串流 instance；否則同時說話會混入上下文。
2. **AudioWorklet 不跑 Python／PyTorch／ONNX inference。**它只作確定性 copy、時間戳、render；推論放在預先啟動並 warm 的 sidecar。這是避免 audio render callback 被同步模型工作阻塞的工程推論；Web Audio 的 render graph 以 render quantum 運作，default quantum 是 128 frames。【[Web Audio API 1.1：render quantum](https://www.w3.org/TR/webaudio/)（存取：2026-08-30）】
3. **佇列必須有上限。**音訊落後時丟棄「過期的 converted block」並切 raw fallback，而不是無限累積後讓口譯越講越晚。要保留 sequence number／capture/render timestamp，不能用 arrival order 猜配對。
4. **禁止轉碼／重傳回 GPT Live。**不要從 output 重新壓縮成 WebRTC input、也不要將 converted RX 餵進 TX／input mic。這只會多一次 codec、延遲與 feedback 風險，且超出問題範圍。
5. **切換須在 block 邊界並清空舊輸出。**raw 與 converted 同時播放會形成回聲；用極短 crossfade 只是一種可測的抗 click 手段，不可用來掩蓋長佇列。

### 3.3 格式契約

| 邊界 | 正確作法 | 不可假定的事 |
| --- | --- | --- |
| GPT Live WebRTC remote track → Web Audio | 以 runtime 的 track／`AudioContext` 實際 rate、channel 數為真實來源，記到 run artifact。 | 不能因為 V3 WebSocket parser 使用 24 kHz mono，就把 WebRTC output 硬設 24 kHz。 |
| Web Audio → sidecar | **工程選擇：**每 frame 加 `streamId`、sequence、monotonic timestamp、sample rate、channels；先明確 downmix，再送 little-endian float32 PCM（或 sidecar 明載的格式）。 | 不把 HTML audio element、base64、WAV 檔案當高頻 IPC；不在每 callback allocate／await。 |
| sidecar → RVC | 僅在此處重採樣至目標 model 的 sample rate；把 resample、model、crossfade 的延遲分開量測。RVC repo 目前有 32k／40k／48k model config，所以由載入 model metadata 決定。 【[RVC model config tree（固定 commit）](https://github.com/RVC-Project/Retrieval-based-Voice-Conversion-WebUI/tree/81eed5e8f68b6bed1789f682fe78cdd324495afc/configs)（存取：2026-08-30）】 | 不以一個全域 sample rate 強迫 Windows device、GPT Live、RVC model 全部一致。 |
| sidecar → sink | 回傳同一條單調 timeline 的 PCM；由 output worklet／destination stream 接回原本 `setSinkId` 的 audio element。 | 不等一句話、逐字稿完成或完整 WAV 才播放。 |

### 3.4 延遲：只訂可量測 gate，不編硬體數字

令 `B` 為 sidecar 的 audio block duration；`C` 是 model 需要的 lookback／context；`T_infer` 是 sidecar 收到完整 block 到回傳的時間；`Q` 是實際 output queue age。則 VC 額外延遲應拆開記為：

```text
L_vc_added = block aggregation(B) + model context(C) + T_infer + Q + render path
```

這是量測分解，不是 vendor SLA。RVC README 自稱可達 170 ms end-to-end、ASIO 下 90 ms，但同一行明說高度依賴硬體／driver；它不能轉寫成此 Intel／AMD iGPU 的預期數字。【[RVC official README（固定 commit）](https://github.com/RVC-Project/Retrieval-based-Voice-Conversion-WebUI/blob/81eed5e8f68b6bed1789f682fe78cdd324495afc/docs/en/README.en.md)（存取：2026-08-30）】

**必要 gate：**

- `p95(T_infer) < B`，並將每一個 `T_infer ≥ B` 記成 deadline miss；
- 在 10 分鐘連續、雙方向壓力測試中，queue age 不可持續增加，不能有未呈現的 overflow／underflow；
- 新管線仍要通過現有 Phase 1 規格的 TTFA P95 ≤ 2.5 s、continuous interpretation lag P95 ≤ 4 s；這是本專案既有 gate，不是 OpenAI／RVC 保證；
- 每一筆結果必附 CPU、GPU adapter／driver、Windows、RVC commit／model hash、provider、`B`、`C`、sample rate、channel、p50/p95/p99、miss count 與 raw-fallback count。

---

## 4. CPU／Intel iGPU／AMD iGPU 的可行能力

### 4.1 不要把 execution provider 誤當成 VC model

ONNX Runtime execution provider 只執行 **ONNX graph**；它可依優先序將不支援的 node 交給 CPU provider。【[ONNX Runtime Execution Providers](https://onnxruntime.ai/docs/execution-providers/)（存取：2026-08-30）】它不會把任意 RVC `.pth` 自動變快。因此「改 OpenVINO／DirectML」必須先有已驗證的 ONNX export、operator coverage、聲音品質 parity 與 stream state 行為；這不屬於 P0。

| 執行路徑 | CPU | Intel iGPU | AMD iGPU | 對本案的判斷 |
| --- | ---: | ---: | ---: | --- |
| **RVC 官方主專案 CPU dependencies** | 有。官方 README 指向 CPU／AMD／Intel 共用 dependency set。 | 不保證使用 iGPU；可作安全 baseline。 | 同左。 | **P0 第一個基準。**CPU 若不能及時完成，不要假定 iGPU 一定救得回來。 【[RVC README](https://github.com/RVC-Project/Retrieval-based-Voice-Conversion-WebUI/blob/81eed5e8f68b6bed1789f682fe78cdd324495afc/docs/en/README.en.md)（存取：2026-08-30）】 |
| **RVC 官方 Windows DirectML path** | 可 fallback。 | RVC 文件說 Windows AMD／Intel 可用 DirectML；其 CPU requirements 也列出 `torch-directml` 與 `onnxruntime-directml`。 | 同樣是可測的 DirectML path。 | **P0 第二個基準。**「可使用」不是 realtime 保證。 【[RVC README](https://github.com/RVC-Project/Retrieval-based-Voice-Conversion-WebUI/blob/81eed5e8f68b6bed1789f682fe78cdd324495afc/docs/en/README.en.md)（存取：2026-08-30）】、【[RVC CPU/DirectML requirements（固定 commit）](https://github.com/RVC-Project/Retrieval-based-Voice-Conversion-WebUI/blob/81eed5e8f68b6bed1789f682fe78cdd324495afc/requirments_cpu_py312.txt)（存取：2026-08-30）】 |
| **ONNX Runtime DirectML** | CPU provider 可排在後備。 | 官方列出 Intel Haswell（第 4 代）整合顯示以上為 DirectML 相容例子。 | 官方列出 AMD GCN 1st Gen 以上例子；實際 APU 仍需由 DX12 driver 實測。 | 可作 Windows 共通的 ONNX acceleration 選項；DirectML 已是 sustained engineering，新 Windows deployment 應一併評估 WinML。 【[ORT DirectML EP](https://onnxruntime.ai/docs/execution-providers/DirectML-ExecutionProvider.html)（存取：2026-08-30）】 |
| **OpenVINO EP** | Intel CPU。 | 官方 `GPU` 指 Intel integrated 或 discrete GPU，並可設定 `AUTO:GPU,NPU,CPU`／`HETERO:GPU,CPU`。 | **不可當 AMD provider。** | 只有在 Intel + 已驗證 ONNX export 時才是後續 spike；不是 RVC P0 的替代品。 【[ORT OpenVINO EP](https://onnxruntime.ai/docs/execution-providers/OpenVINO-ExecutionProvider.html)（存取：2026-08-30）】 |
| **Core ML EP** | Apple CPU／GPU／Neural Engine 的路徑。 | 不適用。 | 不適用。 | Translive 目前 Windows Electron 範圍不使用 Core ML；不要為此新增 macOS scope。 【[ORT Core ML EP](https://onnxruntime.ai/docs/execution-providers/CoreML-ExecutionProvider.html)（存取：2026-08-30）】 |

### 4.2 RVC 的一個容易混淆處

RVC 上游目前另有 `RVCRealtimeVST`，但它的官方 developer guide 說 runtime 由外部 Python worker 加 RVC／CUDA runtime 提供，驗證環境也列 PyTorch CUDA／NVIDIA driver。【[RVC Realtime VST developer guide（固定 commit）](https://github.com/RVC-Project/Retrieval-based-Voice-Conversion-WebUI/blob/81eed5e8f68b6bed1789f682fe78cdd324495afc/RVCRealtimeVST/README.en.md)（存取：2026-08-30）】**不要把這個 VST 專案當作「iGPU 已支援」的證據，也不要為 Translive 引進 VST host。**本案所採用的是主專案已文件化的 CPU／Windows DirectML 路徑。

---

## 5. 候選比較（僅官方 repo／論文／文件）

| 候選 | 使用者聲音材料 | 官方 realtime／硬體證據 | 授權／維護狀態 | Translive 結論 |
| --- | --- | --- | --- | --- |
| **OpenAI Custom Voices** | separate consent + ≤30 秒 sample；由 API 產生 managed voice ID。 | 公開 Realtime 支援 custom voice ID；但本案 GPT Live V3 沒有已驗證的 custom-ID contract。 | 限 eligible customers；服務條件另有 Supplemental Agreement，須法務／採購審閱。 | **若可遷到公開 Realtime，優先。**否則不能當現在 GPT Live 的捷徑。 【[OpenAI Custom Voices](https://developers.openai.com/api/docs/guides/text-to-speech)（存取：2026-08-30）】 |
| **RVC official** | 官方建議至少約 10 分鐘低噪語音來訓練目標 `.pth`；不是一段零樣本 embedding。 | official README 有 real-time GUI；CPU／AMD／Intel dependency 與 Windows DirectML 路徑。README 的 170／90 ms 是該專案自述、依硬體 driver，非本機預測。 | repo `LICENSE` 是 MIT；repo API 在存取日顯示未 archived 且最近 commit 為 2026-08-04。目標 model／資料權利需逐一確認。 | **首選 local P0／P1。**以使用者自己的受權資料訓練，先 CPU、再 DirectML。 【[RVC README](https://github.com/RVC-Project/Retrieval-based-Voice-Conversion-WebUI/blob/81eed5e8f68b6bed1789f682fe78cdd324495afc/docs/en/README.en.md)（存取：2026-08-30）】、【[RVC MIT LICENSE](https://github.com/RVC-Project/Retrieval-based-Voice-Conversion-WebUI/blob/81eed5e8f68b6bed1789f682fe78cdd324495afc/LICENSE)（存取：2026-08-30）】、【[RVC repo API](https://api.github.com/repos/RVC-Project/Retrieval-based-Voice-Conversion-WebUI)（存取：2026-08-30）】 |
| **w-okada/voice-changer** | 它是可載入 RVC 等模型的 realtime client/server，不是另一個自有聲音 clone model。 | 文件稱 real-time VC；Windows v2 可用高效能 CPU 或 DirectML（AMD／NVIDIA）；舊 v1 對 AMD／Intel 的 GPU 途徑是 ONNX-only。 | root 有 MIT notices，但 README 明載部分 bundled/sample voice assets 各有使用條款。repo API 在存取日未 archived。 | **可當人工 no-code 對照／診斷工具，不當首個產品 runtime。**避免打包其 GUI、server 或 sample voices。 【[w-okada README](https://github.com/w-okada/voice-changer/blob/master/README_en.md)（存取：2026-08-30）】、【[w-okada LICENSE-NOTICE](https://github.com/w-okada/voice-changer/blob/master/LICENSE-NOTICE)（存取：2026-08-30）】 |
| **OpenVoice** | 官方宣稱 zero-shot cross-lingual tone-color cloning；原始碼可由 reference audio extract speaker embedding，並保存 `.pth`。 | 官方使用文件主要是 Linux/Python/PyTorch；其他平台指南明示 community/unofficial。官方沒有本案可引用的 streaming realtime latency／Intel／AMD iGPU contract；`convert` API 讀取 source audio path、輸出音訊，非串流介面。 | V1／V2 code 為 MIT；repo 最近 commit（存取時）為 2025-04-19，未 archived。 | **不選。**可以離線比較音色，不把「instant」誤當 low-latency post-VC。 【[OpenVoice README](https://github.com/myshell-ai/OpenVoice/blob/main/README.md)（存取：2026-08-30）】、【[OpenVoice usage](https://github.com/myshell-ai/OpenVoice/blob/main/docs/USAGE.md)（存取：2026-08-30）】、【[OpenVoice conversion source](https://github.com/myshell-ai/OpenVoice/blob/main/openvoice/api.py)（存取：2026-08-30）】、【[OpenVoice repo API](https://api.github.com/repos/myshell-ai/OpenVoice)（存取：2026-08-30）】 |
| **Seed-VC** | 官方 README 為 zero-shot，reference speech 1–30 秒，可不訓練。 | 官方宣稱 zero-shot real-time VC、約 300 ms algorithmic + 100 ms device-side delay，但又明確**強烈建議 GPU**，範例 benchmark 是 NVIDIA RTX 3060 Laptop；沒有 Intel／AMD iGPU realtime 證據。 | GPL-3.0；repo API 顯示 `archived: true`，owner archive date 為 2025-11-21。 | **不選。**即使它的零樣本 UX 很好，也不符合本機硬體、維護與產品授權風險。 【[Seed-VC README](https://github.com/Plachtaa/seed-vc/blob/main/README.md)（存取：2026-08-30）】、【[Seed-VC GPL-3.0](https://github.com/Plachtaa/seed-vc/blob/main/LICENSE)（存取：2026-08-30）】、【[Seed-VC repo API](https://api.github.com/repos/Plachtaa/seed-vc)（存取：2026-08-30）】 |

### 比較結論

- **不要選 OpenVoice 作為 GPT Live output 的 realtime converter：**它有 tone conversion code，卻沒有官方 streaming／Windows iGPU realtime contract；把檔案式 `convert` 硬改為 callback loop 是新的模型工程。
- **不要選 Seed-VC：**其數字是 NVIDIA benchmark 情境與 algorithmic/device breakdown，不可外推 iGPU；GPL-3.0 加 archived 使它更不適合作為預設產品依賴。
- **不要把 w-okada 當成 RVC 的替代模型：**它適合省下 P0 的手工音訊測試架設，但其 packaged assets／runtime 路徑的散布責任比直接、最小化地控制 RVC sidecar 更大。
- **RVC 是「最低風險的可測候選」，不是「保證 realtime」。**真正答案由本機 `p95(T_infer)`、隊列與雙向 run 的量測決定。

---

## 6. 最小可落地計畫與驗收門檻

### P0：不寫產品碼的 two-gate spike

1. **OpenAI gate（平行、零音訊繞路）：**請 account/sales 回答 Custom Voices 是否已對該 organization 開放，以及哪個**公開** Realtime model／商用方案可用；保存書面結果，不以未文件化 GPT Live request 探測。
2. **RVC hardware gate（本機、無 app 改動）：**以使用者本人同意的 target-voice training data 建一個 RVC model；將同一組、已獲允許保存的 GPT-output 音訊 fixture 送入 RVC 官方 realtime GUI／測試流程，依序跑 CPU、Windows DirectML。記錄實際 adapter、driver、provider，並使用 GPT Live 會遇到的 sample-rate/channel 條件。

**P0 不通過就停止。**不要因為 CPU 慢而立刻寫 driver、採 OpenVINO export、或改成 OpenVoice／Seed-VC。

### P1：只接一條 RX output 的最小整合

僅將 `createRealtimePeer` 收到的 **RX remote track** 從直接 `<audio>.setSinkId(headphones)` 改為第 3 節的 processed path；保留 raw branch、既有 `setSinkId`、既有 mode／route validation。這能驗證：

- browser/Electron remote track 是否可穩定進 Web Audio；
- sidecar IPC、warm-up、deadline、fallback 是否正確；
- 不改動 TX Cable-A／meeting route 下，耳機端有沒有可接受的額外延遲與音色。

### P2：只在 P1 通過後擴到 TX 與雙向

為 TX 建另一個 converter instance；跑既有 Zoom／Teams、10 分鐘、重疊說話、mute／stop／device-switch 矩陣。**同一 RVC model 可以共用磁碟權重，不能共用 stream state。**

### 必留的量測與 go/no-go

| 類別 | 必記錄／判定 |
| --- | --- |
| 模型服務時間 | 每 block 的 ingress／egress 時戳，`B`、context、resample、`T_infer`；`p95(T_infer) < B`。 |
| 穩定性 | 10 分鐘連續 run 的 queue age 曲線、p99、late／dropped／fallback／underflow／overflow count；不可有無界 backlog。 |
| 端到端 | 與「同一台、同網路、無 VC」baseline 對照 first-audio 與 interpretation lag；仍滿足既有 Phase 1 gate。 |
| 品質 | 不同語言、快速語句、數字、姓名、停頓、男女聲情境，由聲音所有者與雙語 reviewer 判斷可理解度與目標音色；不得只聽一段 demo。 |
| 供應鏈 | RVC commit、Python/runtime、model hash、provider／adapter／driver、目標資料授權與 consent version 固定在 evidence。 |

### fallback 行為（產品需要，而非事後補丁）

- **正常 fallback：**sidecar 未 ready、load error、deadline miss、GPU device removal、queue age 超限時，清空 converted output，於下一個完整 block 切至 raw GPT Live audio；顯示可見狀態，但不中斷翻譯。
- **不採用的 fallback：**再開一條 OpenAI TTS、STT→TTS、重新送給 GPT Live、或無限增加 buffer。這些會改變語義、成本、隱私與延遲，且沒有解決本機 VC 效能。
- **長期 fallback：**如果 OpenAI 原生 custom voice eligibility + 公開 Realtime migration 都通過，可以以原生 custom voice 取代本機 VC；那是獨立架構決策，而非 P1 內建雙實作。

---

## 7. 聲音材料、embedding、consent 與安全

### 7.1 不同方案所需材料不可混為一談

| 路徑 | 真正需要的材料 | 重要限制 |
| --- | --- | --- |
| OpenAI Custom Voice | exact consent recording + matching sample（≤30 秒）。 | OpenAI 強制 consent flow／eligible org；不可用 local UI 自我聲明取代其 API consent。 【[OpenAI Custom Voices](https://developers.openai.com/api/docs/guides/text-to-speech)（存取：2026-08-30）】 |
| RVC | 目標說話者的乾淨訓練資料與產出的 `.pth`／可選 index；官方建議至少約 10 分鐘低噪語音。 | 沒有 OpenAI 式內建 consent enforcement；Translive 必須自己實作使用者確認與資料治理。 【[RVC README](https://github.com/RVC-Project/Retrieval-based-Voice-Conversion-WebUI/blob/81eed5e8f68b6bed1789f682fe78cdd324495afc/docs/en/README.en.md)（存取：2026-08-30）】 |
| OpenVoice | reference audio 會抽取／保存 speaker embedding；原始碼使用 `extract_se` 與 `.pth` embedding。 | 不是「embedding 就沒有風險」；它仍是可用來合成該音色的敏感 artifact。 【[OpenVoice speaker-embedding source](https://github.com/myshell-ai/OpenVoice/blob/main/openvoice/se_extractor.py)（存取：2026-08-30）】 |
| Seed-VC | 1–30 秒 reference，zero-shot。 | 技術上最少材料不等於取得該人的合法權利；且本案不採用。 【[Seed-VC README](https://github.com/Plachtaa/seed-vc/blob/main/README.md)（存取：2026-08-30）】 |

### 7.2 Translive 必須做的最小安全控制（工程／產品建議）

1. **只允許本人 voice profile：**首次建立／匯入時以明確 UI 聲明「我擁有並被授權使用此聲音」，顯示用途（即時翻譯輸出）與刪除方式；禁止從 URL、會議錄音、聯絡人或雲端自動抓取聲音。
2. **把 consent、sample、model、embedding 都視為敏感資料：**預設不寫 raw audio／embedding 至 telemetry、crash dump 或 run evidence；只保存必要的 consent version、時間、profile ID、hash 與撤銷狀態。
3. **本機最小權限儲存：**voice profile／RVC model 放使用者 scope 的受限目錄；刪除 profile 要刪 model、index、embedding、sidecar cache 與選擇紀錄。不要在 shared temp、repo、log 或 meeting evidence 留副本。
4. **sidecar 不開網路服務：**使用受 ACL 保護的本機 IPC（例如 loopback-only 並帶隨機 session capability，或 named pipe/shared memory）；拒絕任意 LAN client、任意 model URL、未驗證 plugin／model path。檢查 runtime／model hash，防止用「voice model」夾帶可執行檔。
5. **使用中可見且可停：**UI 顯示「自訂合成音色啟用」、profile 名稱及 raw fallback；在會議或外送前讓操作者能一鍵關閉。是否另需對與會者揭露，交由適用法域、組織政策與客戶合約審查；本報告不作法律結論。
6. **反濫用：**不提供預設名人／第三方 voice packs，不允許匯出／分享 profile model；保留本機 audit metadata 以支持撤銷，但不收集不必要的原始音訊。

---

## 8. 對 scope、驗收、架構與 validation 的影響

### Scope

- **納入：**一條 post-output VC seam、RVC local sidecar 的 CPU／DirectML spike、raw fallback、profile consent／storage 最小控制、per-direction performance evidence。
- **不納入：**新 virtual driver、VST host、RVC fork／訓練 UI、ONNX/OpenVINO conversion、OpenVoice／Seed-VC integration、任意人物 voice marketplace、雲端模型上傳、額外 STT/TTS pipeline。

### Acceptance

1. **OpenAI native path 合格**：只有在 eligible entitlement 與公開 API/model contract 均證實後，才可驗收「不需 local VC」。
2. **local VC path 合格**：P0 CPU／DirectML 實機 evidence 滿足 `p95(T_infer) < B`、無 backlog、既有 Phase 1 latency gate 仍通過、兩方向隔離正確、可在失敗時 raw fallback。
3. **不合格但可完成的結果**：某台 iGPU 無法達 gate，是正確的 no-go evidence；此時交付原 GPT 內建聲音，不以更多 buffer 偽裝即時。

### Architecture

- 修改點限於 renderer 的 remote-output playback seam；Codex app-server、GPT Live auth、input capture、Virtual Cable A/B、兩個 thread／PeerConnection 全部保持不變。
- sidecar 是一個**最小本機處理程序邊界**，不是新的通用 plugin platform；一條 output stream 一個 instance，只有 audio blocks／控制訊息。
- 使用 provider capability 做啟動時選擇：CPU baseline → Windows DirectML；Intel 機器只有在已驗證 ONNX graph 時才探索 OpenVINO。品牌名不是能力探測結果。

### Validation

- 在同硬體、同網路、同 fixture 下，對照 raw GPT baseline 與 VC CPU／DirectML run。
- 每次 run 產出可匿名化的 metrics artifact，不包含 raw audio、custom voice sample、embedding、API key、SDP 或完整 transcript。
- Zoom／Teams 僅在 P1 RX、P2 TX 都通過後測；不可用本機 meter 取代遠端參與者驗證。

---

## 9. 尚未驗證、需要產品決策的問題

1. OpenAI 是否已為此 organization 開通 Custom Voices？可用的**公開** Realtime model、地域、價格、商用條款與資料控制為何？
2. 產品能否接受從 Codex experimental GPT Live V3 遷到公開 Platform Realtime？若不能，是否接受本機 RVC profile 的品質差異？
3. 實際機器是 Intel 還是 AMD、CPU 型號、iGPU、RAM、Windows 版本與 graphics driver 是什麼？沒有它們就不能推測 realtime。
4. 「自己的音色」是否只限本人、是否需要多 profile、是否要中英皆穩定、能否接受 RVC 約 10 分鐘的訓練資料與一次 profile 建置？
5. profile／model 是否可留本機、可否要求使用者隨時刪除、是否受企業 MDM／roaming profile／資安政策限制？
6. 既有 GPT Live Phase 1 是否先在真實帳號證實翻譯／雙向路由？若 upstream GPT Live entitlement 本身 no-go，先解該 blocker，不要把 VC 當繞過。

---

## 一句話落地建議

**先用官方 RVC 的 CPU 與 Windows DirectML path 對同一台機器做 local-output benchmark；通過才在 `remote track → setSinkId` 間插入一個有界、每方向獨立的本機 RVC sidecar 與 raw fallback。**同時向 OpenAI 查 entitlement；只有遷到文件化 Realtime 且取得 custom-voice 資格時，才以原生 Custom Voice 取代這條 local VC 路徑。

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "僅產出指定的一份繁體中文研究 Markdown；範圍限於 GPT Live 後 custom voice conversion 的主來源調查、架構與驗證建議，未修改任何 Translive 原始碼、規格或他人工作樹檔案。"
    },
    {
      "id": "criterion-2",
      "status": "satisfied",
      "evidence": "報告緊鄰列出 OpenAI 官方文件、OpenAI Codex 上游固定 SHA、RVC/OpenVoice/Seed-VC/w-okada 官方 repo、W3C 規格、ONNX Runtime/OpenVINO 官方文件；並提供可重現的 CPU/DirectML gate、fallback、未驗證項目與 no-go 條件。"
    }
  ],
  "changedFiles": [
    "/home/timmypai/.pi/agent/sessions/--home-timmypai-apps-translive--/subagent-artifacts/outputs/034a13bf-e68f-4029-bcf2-9ea938afe3ad/docs/research/post-gpt-live-custom-voice-conversion.md"
  ],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "functions.read docs/research/*, docs/specs/*, src/phase-one-controller.js, src/dual-channel-run.js, src/renderer-entry.js",
      "result": "passed",
      "summary": "讀取既有 GPT Live、Windows routing、Phase 1 spec 與實際 WebRTC remote-track playback 路徑。"
    },
    {
      "command": "functions.fetch_content first-party OpenAI, OpenAI/Codex upstream, RVC, OpenVoice, Seed-VC, w-okada, W3C, ONNX Runtime, OpenVINO sources",
      "result": "passed",
      "summary": "取得一手文件、固定 SHA 原始碼、LICENSE 與 repo API 狀態。"
    },
    {
      "command": "functions.source_check load-bearing API, Codex enum, RVC, provider, candidate claims",
      "result": "passed",
      "summary": "以官方來源查核高承載主張；報告將 GPT Live custom-voice entitlement 明確保留為未驗證。"
    },
    {
      "command": "git diff --check && git diff --cached --name-only",
      "result": "not-run",
      "summary": "此 research runtime 沒有 shell/git 執行工具；本次唯一寫入是指定 session artifact，未呼叫任何 staging 操作。"
    }
  ],
  "validationOutput": [
    "OpenAI Custom Voices 已區分為公開 Realtime 的 conditional native path，而非現有 experimental GPT Live 的已證實能力。",
    "RVC、OpenVoice、Seed-VC、w-okada 的 realtime、硬體、授權與維護狀態均以各自 upstream source 表述；未外推硬體 latency 數字。",
    "建議的 P0/P1/P2 驗證以 p95(T_infer) < block duration、bounded queue、既有 Phase 1 gates 與 raw fallback 為可獨立審查的門檻。"
  ],
  "residualRisks": [
    "未以任何 API key 探測未文件化 GPT Live endpoint，因此沒有也不聲稱目前帳號具 Custom Voice entitlement。",
    "實際 CPU/iGPU 型號、driver、RVC target model 與音色品質尚未量測；本報告明確要求先做實機 P0。",
    "無 shell 工具可獨立列出既有 git index；artifact 寫入工具本身不會 stage 檔案。"
  ],
  "noStagedFiles": true,
  "diffSummary": "新增一份僅含研究的繁體中文 Markdown artifact；未修改產品程式碼。",
  "reviewFindings": [
    "blocker: 現有 Codex GPT Live V3 client 只有內建 RealtimeVoice enum，公開 OpenAI Custom Voices 文件不能證明它可用 custom voice ID。",
    "no blockers: local RVC CPU/DirectML P0 可在不擴張 driver、VST 或 STT/TTS 範圍下驗證硬體可行性。"
  ],
  "manualNotes": "建議 reviewer 特別確認：產品是否允許公開 Realtime migration；若否，接受本機 RVC sidecar 的 consent、model storage 與 raw fallback UX。"
}
```

## 10. 2026-08-31 P0–P3 foundation implementation status

### 已完成，且不宣稱已 clone 或轉換任何音色

- **P0 capability gate：**新增只讀 `scripts/probe-rvc-capability.ps1`，回報 CPU、GPU、driver、RAM 與 Python／ffmpeg／torch／DirectML presence 的遮罩 JSON。它不下載、不安裝、不載入模型、不輸出 executable path、環境變數、模型路徑或聲音資料。
- **目前 Windows receipt：**Intel Core Ultra X7 358H、Intel Arc B390 GPU、driver `32.0.101.8359`、32 GB RAM、無 NVIDIA。Python、ffmpeg、torch、DirectML 與已釘選的 RVC runtime 均為 unavailable，因此 capability 狀態是 **unavailable**，只能走原 GPT 音色。
- **P1 profile boundary：**`VoiceProfileStore` 僅在明確確認「本人或已獲授權」後，從使用者在 native file picker 選擇的本機 `.pth`（選用 `.index`）建立 user-scope profile。manifest 固定 consent version、profile ID、hash 與 `rvc-local-trainer` provenance；renderer 只得到 ID、顯示名稱、consent version、imported state，沒有 path、hash、sample、embedding 或 model bytes。
- **安全載入界線：**`.pth` 視為潛在可執行 artifact；Node/Electron 不載入它。manifest 明確要求未來 sidecar `weightsOnlyRequired: true`。沒有已驗證、weights-only 的 pinned sidecar 時，toggle 會回到 OFF／unavailable，絕不假裝已轉換。
- **P2 protocol foundation：**versioned local frame protocol 限 `stdio`／named pipe，不接受 TCP/LAN；每 frame 必有 stream ID、direction、連續 sequence、monotonic timestamp、runtime sample rate、channel count、Float32 byte length。它只是一個測試過的契約，尚未接到 WebRTC track。
- **P3 deadline foundation：**每個 TX/RX direction 各有獨立 controller，限制 outstanding frames、queue age 與 latency samples；not-ready、overflow、deadline miss、device removal 都在 frame boundary 回 raw，沒有 unbounded buffer 或 raw/converted 混播。fake sidecar 只存在於 test fixture，沒有 product fake converted path。
- **UI：**設定頁加入預設 OFF 的「本機自訂音色 RVC」toggle、本人 profile picker、capability/status 與明確同意後的 native `.pth` import entry。P4 audio-track integration 仍是 disabled；目前任何 enable request 都安全回 original GPT voice，直到真實 gate 通過。

### 真實 P5 benchmark 的外部 gates（全部尚未通過）

1. 安裝 **Windows Python 3.12**（不能是 WindowsApps alias），並以可重現 lockfile 建立 pinned RVC official runtime（upstream commit `81eed5e8f68b6bed1789f682fe78cdd324495afc`）。
2. 安裝可驗證的 **ffmpeg**、**torch**，及 Intel Arc 上要測的 **torch-directml／DirectML**；probe 必須回報 presence，但不得將「存在」當作 realtime 成功。
3. 實作並安全審查真正 local-only, weights-only sidecar（no TCP/LAN、每方向各一 instance、模型 hash/provenance 驗證）。
4. 聲音所有者提供本人或明確授權、乾淨的訓練資料，或一個本人已訓練的 model/index；未取得前不得訓練、clone、上傳或測試第三方音色。
5. 用同一已獲允許保存的 fixture，依 CPU 再 DirectML 跑 P5：`p95(T_infer) < block duration`、10 分鐘 queue age 不增加、既有 TTFA／interpretation lag gate 不退化、deadline/device failure 可聽的 raw fallback；輸出只留匿名 metrics，不留 raw audio。
6. P5 通過後才可做 P4 的 **RX-only** remote-track integration；TX 和雙向只在 RX 實測通過後進行。

**目前可驗收行為：**使用者可看到並管理安全的設定檔 metadata，但本機轉換不會啟動；所有 GPT‑Live 音訊維持既有 raw output path。

---
