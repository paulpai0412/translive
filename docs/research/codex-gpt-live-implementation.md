# Codex「GPT Live 可用」主來源調查

- **調查日期：**2026-08-28
- **Codex 固定版本：**`7625343977154efed8c0dadba956374992a1580b`（當時 `openai/codex` `main`）
- **結論：**Codex 原始碼確有名為 `gpt-live-1-codex` 的 V3/Frameless Bidi 整合；可用目前登入 Codex 的環境做 **experimental P0 PoC**。但它不是目前可證實的公開 Platform API 合約，因此 **PoC 為 Go、對外 production 依賴則為 Conditional No-go**，直到 OpenAI 確認 entitlement、支援與商業使用條件。

> 本報告只以 OpenAI 官方 GitHub 原始碼／歷史／release、官方 Platform 文件與官方 OpenAPI 規格為證。
> 貼上的「全雙工、次秒、可商用」主張均視為假說，未以社群貼文補強。

## 1. 已釘選的原始碼事實

### 1.1 模型、版本、端點與傳輸

Codex V3 的預設 Frameless 模型確實是 `gpt-live-1-codex`：

```rust
const DEFAULT_FRAMELESS_REALTIME_MODEL: &str = "gpt-live-1-codex";
```

來源：[`realtime_conversation.rs#L108-L109`](https://github.com/openai/codex/blob/7625343977154efed8c0dadba956374992a1580b/codex-rs/core/src/realtime_conversation.rs#L108-L109)。
V3 選用此模型並映射為 `RealtimeEventParser::FramelessBidi`：
[`#L1383-L1397`](https://github.com/openai/codex/blob/7625343977154efed8c0dadba956374992a1580b/codex-rs/core/src/realtime_conversation.rs#L1383-L1397)。

Frameless WebSocket 路徑會正規化為 `/v1/live`；既有 WebRTC call 的 sideband 則把 `call_id` 加為路徑段：
[`methods.rs#L1137-L1170`](https://github.com/openai/codex/blob/7625343977154efed8c0dadba956374992a1580b/codex-rs/codex-api/src/endpoint/realtime_websocket/methods.rs#L1137-L1170)。
HTTP call 建立在非 backend provider 的 Frameless 情形選擇 `live`，即 `POST /v1/live`：
[`realtime_call.rs#L64-L77`](https://github.com/openai/codex/blob/7625343977154efed8c0dadba956374992a1580b/codex-rs/codex-api/src/endpoint/realtime_call.rs#L64-L77)。

但這是**客戶端組包行為**，不是 OpenAI 對一般 Platform 專案的可用性承諾。
目前官方模型頁的 `gpt-live-1-codex` URL 查詢為 404，且官方 Realtime 導覽沒有列出它或 `/v1/live`；這是「沒有公開文件」的證據，不是服務永遠不存在的數學證明。

### 1.2 V3 wire payload 與事件

V3 Frameless session bootstrap 的實際欄位是：

```json
{
  "instructions": "…",
  "audio": { "output": { "voice": "…" } },
  "delegation": { "type": "client" },
  "model": "…"
}
```

`model` 與 `delegation.ack_filler` 是可選欄位；**沒有** wire 層 `prompt` 或 target-language 欄位。
來源：[`methods_frameless_bidi.rs#L52-L75`](https://github.com/openai/codex/blob/7625343977154efed8c0dadba956374992a1580b/codex-rs/codex-api/src/endpoint/realtime_websocket/methods_frameless_bidi.rs#L52-L75)。

V3 送音訊使用 `input_audio.append`，V1/V2 則為 `input_audio_buffer.append`：
[`methods.rs#L314-L324`](https://github.com/openai/codex/blob/7625343977154efed8c0dadba956374992a1580b/codex-rs/codex-api/src/endpoint/realtime_websocket/methods.rs#L314-L324)。
內部 parser 接受的 V3 回傳事件包括：
`session.started|session.updated`、`output_audio.delta`、`input_transcript.added`、
`output_transcript.added`、`turn.done`、`delegation.created`、`error`：
[`protocol_frameless_bidi.rs#L17-L29`](https://github.com/openai/codex/blob/7625343977154efed8c0dadba956374992a1580b/codex-rs/codex-api/src/endpoint/realtime_websocket/protocol_frameless_bidi.rs#L17-L29)。

`output_audio.delta` 的 parser 將 `audio` 映射為 24 kHz、mono 的 `RealtimeAudioFrame`；
輸入格式在此 V3 原始碼中沒有公開 schema／codec 約束：
[`protocol_frameless_bidi.rs`](https://github.com/openai/codex/blob/7625343977154efed8c0dadba956374992a1580b/codex-rs/codex-api/src/endpoint/realtime_websocket/protocol_frameless_bidi.rs)。
App-server 音訊 chunk 雖含 `data`、`sampleRate`、`numChannels`、`samplesPerChannel`，
但 `data` 僅型別為 `String`，沒有把 PCM、base64 或 codec 寫成外部契約：
[`protocol.rs#L364-L373`](https://github.com/openai/codex/blob/7625343977154efed8c0dadba956374992a1580b/codex-rs/protocol/src/protocol.rs#L364-L373)。

### 1.3 這不是翻譯產品功能

Codex 的模式只有 `Conversational`／`Transcription`：
[`protocol.rs#L31-L47`](https://github.com/openai/codex/blob/7625343977154efed8c0dadba956374992a1580b/codex-rs/codex-api/src/endpoint/realtime_websocket/protocol.rs#L31-L47)。
app-server 文件將 V3 描述為保留 Codex Voice 行為、採用 `delegation.*` 的語音／coding-agent 整合，
而 `appendSpeech` 是「讓 realtime model 對使用者說」的文字：
[`app-server/README.md#L214-L220`](https://github.com/openai/codex/blob/7625343977154efed8c0dadba956374992a1580b/codex-rs/app-server/README.md#L214-L220)。

因此，原始碼證實「串流語音輸入、音訊輸出、轉寫、Codex handoff」，**未證實**：
語音對語音翻譯、持續翻譯音訊、目標語言、雙向翻譯協調、或次秒 latency SLA。
用 `prompt` 要模型翻譯屬未驗證提示詞行為，不能當產品能力。

## 2. 候選主張逐項核對

| 主張／識別字 | 結果 | 主來源與限定 |
| --- | --- | --- |
| `gpt-live-1-codex` | **已證實（僅 Codex 預設）** | V3 default；非公開 model entitlement 證明。見上節。 |
| Frameless Bidi V3 | **已證實** | `v3 → FramelessBidi`；WebSocket、WebRTC 都有實作。 |
| `/live`、`/v1/live` | **已證實（Codex 組包）** | V3 URL／call route 如上；不是公開文件端點。 |
| `thread/realtime/start | stop | appendAudio | appendText | appendSpeech` | **已證實（本機 app-server RPC）** | 皆標為 experimental，不是 Platform API。[`README#L214-L220`](https://github.com/openai/codex/blob/7625343977154efed8c0dadba956374992a1580b/codex-rs/app-server/README.md#L214-L220) |
| `{type:"webrtc",sdp}` 與 `thread/realtime/sdp` | **已證實** | start transport／SDP notification schema：[`v2/realtime.rs#L194-L294`](https://github.com/openai/codex/blob/7625343977154efed8c0dadba956374992a1580b/codex-rs/app-server-protocol/src/protocol/v2/realtime.rs#L194-L294)。 |
| `model` override | **已證實（本機參數）** | 參數優先於 config/default；不代表任意 slug 獲 upstream 接受。 |
| `version`、`outputModality` | **部分證實** | V3 存在；V3/V1 要求 audio，text 僅 V2：[`core#L840-L845`](https://github.com/openai/codex/blob/7625343977154efed8c0dadba956374992a1580b/codex-rs/core/src/realtime_conversation.rs#L840-L845)。 |
| `prompt` | **部分證實** | app-server 接受，轉成 wire `instructions`；不是 `/live` 的 `prompt` 欄位。[`core#L795-L798`](https://github.com/openai/codex/blob/7625343977154efed8c0dadba956374992a1580b/codex-rs/core/src/realtime_conversation.rs#L795-L798)、[`#L862-L864`](https://github.com/openai/codex/blob/7625343977154efed8c0dadba956374992a1580b/codex-rs/core/src/realtime_conversation.rs#L862-L864) |
| `voice` | **已證實（本機 V3）** | V3 接受 v1 voice 集合：Juniper…Cove；預設 Cove。[`protocol.rs#L320-L360`](https://github.com/openai/codex/blob/7625343977154efed8c0dadba956374992a1580b/codex-rs/protocol/src/protocol.rs#L320-L360) |
| `includeStartupContext` | **已證實（Codex context）** | 控制 Codex 產生的 startup context，不是 upstream 翻譯設定。 |
| `delegationAckFiller` | **已證實（V3 wire）** | 對應 `delegation.ack_filler`；V1/V2 不適用。 |
| `clientManagedHandoffs` | **已證實（本機控制）** | 只抑制 Codex 自動 handoff：[`core#L554-L556`](https://github.com/openai/codex/blob/7625343977154efed8c0dadba956374992a1580b/codex-rs/core/src/realtime_conversation.rs#L554-L556)。 |
| `quicksilver`／`avas` feature flag | **已證實為 request selector；否定為客戶旗標** | V1／backend V3 加 `intent=quicksilver&architecture=avas`：[`realtime_call.rs#L216-L230`](https://github.com/openai/codex/blob/7625343977154efed8c0dadba956374992a1580b/codex-rs/codex-api/src/endpoint/realtime_call.rs#L216-L230)。沒有客戶 allowlist 證據。 |
| 兩個同 thread session | **否定** | 同一 `RealtimeConversationManager` 僅存一個 `Option<ConversationState>`；新 start 會 stop 舊 session：[`core#L129-L132`](https://github.com/openai/codex/blob/7625343977154efed8c0dadba956374992a1580b/codex-rs/core/src/realtime_conversation.rs#L129-L132)、[`#L530-L546`](https://github.com/openai/codex/blob/7625343977154efed8c0dadba956374992a1580b/codex-rs/core/src/realtime_conversation.rs#L530-L546)。 |
| 兩個不同 thread／process session | **未知** | 原始碼沒有全域鎖，但也沒有 backend 可同時接受／翻譯的實證。 |
| 「full-duplex、<1 秒」 | **未證實** | 有非同步 streaming 形狀，沒有數值 latency 測試或 SLA。 |

## 3. 公開 Platform 與 Codex／ChatGPT 認證的關鍵差異

### 已證實的 Codex 請求建構

- WebSocket start 會取得 `realtime_api_key()`，否則回報
  `"realtime conversation requires API key auth"`，並建立 `Authorization: Bearer …`：
  [`core#L1686-L1746`](https://github.com/openai/codex/blob/7625343977154efed8c0dadba956374992a1580b/codex-rs/core/src/realtime_conversation.rs#L1686-L1746)。
- 若 provider base URL 含 `/backend-api`，WebRTC call 走 ChatGPT/Codex backend 的 JSON shape；
  否則 `/v1/live` 使用 multipart SDP + session：
  [`realtime_call.rs#L64-L202`](https://github.com/openai/codex/blob/7625343977154efed8c0dadba956374992a1580b/codex-rs/codex-api/src/endpoint/realtime_call.rs#L64-L202)。
- WebRTC sideband 會重用建立 call 的 auth；註解明說 API-key session 用 API bearer，
  ChatGPT-auth session 用 bearer 加 account id：
  [`client.rs#L415-L435`](https://github.com/openai/codex/blob/7625343977154efed8c0dadba956374992a1580b/codex-rs/core/src/client.rs#L415-L435)、[`#L697-L725`](https://github.com/openai/codex/blob/7625343977154efed8c0dadba956374992a1580b/codex-rs/core/src/client.rs#L697-L725)。

### 不能從上述推論的事

這些分支只證明 Codex **會嘗試**用 API key 或 ChatGPT 身分送出請求；
它們不證明正常 Platform key 有 `gpt-live-1-codex` entitlement、也不證明 ChatGPT OAuth 可供第三方產品轉交／包裝。
不得把使用者的 ChatGPT OAuth bearer、account id、Codex session 或未文件化 header 嵌入 Windows app。

Codex 自己也把 realtime config 標成「Experimental / do not use」：
[`config_toml.rs#L395-L418`](https://github.com/openai/codex/blob/7625343977154efed8c0dadba956374992a1580b/codex-rs/config/src/config_toml.rs#L395-L418)。
app-server 的 WebSocket listener 更明示「experimental / unsupported」：
[`app-server/README.md#L27`](https://github.com/openai/codex/blob/7625343977154efed8c0dadba956374992a1580b/codex-rs/app-server/README.md#L27)。

## 4. 與公開 `gpt-realtime-translate` 的事實／假說比較

| 面向 | Codex GPT-Live 路徑 | 公開 `gpt-realtime-translate` 路徑 | 判定 |
| --- | --- | --- | --- |
| 模型／端點 | source 有 `gpt-live-1-codex` + `/v1/live`；無公開 contract | 官方列出模型與 `/v1/realtime/translations` | 翻譯應選後者。[官方總覽](https://developers.openai.com/api/docs/guides/realtime) |
| 連續翻譯 | 無 target-language／translation schema | 官方明示音訊進、翻譯音訊與 transcript delta 持續出，不呼叫 `response.create` | 已證實僅後者。[翻譯指南](https://developers.openai.com/api/docs/guides/realtime-translation) |
| WebRTC／WebSocket | source 有兩者；非公開／experimental | browser 用 WebRTC；server media pipeline 用 WebSocket | 已文件化僅後者。[翻譯指南](https://developers.openai.com/api/docs/guides/realtime-translation) |
| 目標語言 | 無 | `session.audio.output.language` | 已證實僅後者。[client secret 參考](https://developers.openai.com/api/reference/resources/realtime/subresources/translations/subresources/client_secrets/methods/create/) |
| voice 選擇 | V3 本機可選 v1 voice；非產品承諾 | 翻譯文件只文件化 output language，未文件化 target voice | 不能承諾任一路徑的翻譯 voice UX。 |
| latency | 無數值證據 | 文件稱 speaking 時串流、要求自行量測；無數值 SLA | 「次秒」兩邊都是待測假說。 |
| 生產支援 | RPC experimental；listener unsupported；內部依賴 | 公開、文件化 Platform surface（非 SLA 宣稱） | GPT-Live 不可當 production dependency。 |
| 雙向兩人 | 同 thread 不可雙 session；跨 thread 未驗證 | 官方建議每方向一個 translation session、音軌分離 | 已證實僅後者。[翻譯指南](https://developers.openai.com/api/docs/guides/realtime-translation) |

## 5. 可重用與不可重用的部分

Codex repository 是 Apache-2.0：[`LICENSE#L1-L2`](https://github.com/openai/codex/blob/7625343977154efed8c0dadba956374992a1580b/LICENSE#L1-L2)。
可在遵守該授權／NOTICE 的前提下參考或重用**本地程式碼概念**：

1. WebRTC SDP offer/answer 與遠端音軌播放的 UI 流程；
2. audio、transcript、close/error 的非同步狀態機；
3. 將每位來源說話者／目標語言拆成獨立 session 的資源模型；
4. 限界 queue、重連、遙測與 audio 裝置選擇等工程模式。

不可視為可自由產品化的部分：`/v1/live`、ChatGPT `/backend-api/codex/...`、
`openai-alpha`、`quicksilver`／`avas`、Codex/ChatGPT bearer 與 account headers、
`gpt-live-1-codex` 的服務 entitlement。Apache 原始碼授權不等於託管服務、模型、商標或帳戶權利。
對外產品若包裝 ChatGPT/Codex 基礎設施，須先取得 OpenAI 書面產品／法務確認；本報告不是法律意見。

## 6. 歷史與 release 脈絡

- PR/commit [`2e1607e`](https://github.com/openai/codex/commit/2e1607ee2fa8099a233df7437adee5f16a741905)
  在 2026-07-15 加入 Frameless Bidi V3、`/live`、WebSocket 與 WebRTC。
- commit [`068c49f`](https://github.com/openai/codex/commit/068c49f075cf287a1fe7d1ee36cf005efac922e7)
  在 2026-08-24 將 default 從 `gpt-live-1-boulder-alpha` 改為 `gpt-live-1-codex`，並測試明確 model override。
- 官方 release [`rust-v0.145.0`](https://github.com/openai/codex/releases/tag/rust-v0.145.0) 列出 streaming realtime V3；
  [`rust-v0.150.0`](https://github.com/openai/codex/releases/tag/rust-v0.150.0) 列出 frameless realtime default model 更新。

父執行環境另行驗證本機 `/home/timmypai/.nvm/versions/node/v24.18.0/bin/codex`：`codex --version` 回傳 `codex-cli 0.145.0`；它連到 `@openai/codex/bin/codex.js`，套件 metadata 為 `@openai/codex` `0.145.0`、Apache-2.0，原生 binary 位於套件的 `codex-linux-x64` vendor 目錄。報告仍以釘選 upstream source 為權威，不以編譯 binary 中的字串取代原始碼證據。

## 7. P0：不要做 GPT-Live shipping；可做的最小驗證

### 7.1 不碰未文件化端點的 falsification 實驗

1. 以 secret manager 注入一次性、server-side Platform key；不寫入 repo、桌面 client、log 或截圖。
2. 用已文件化的 `GET /v1/models/gpt-live-1-codex` 查詢，並以 `gpt-realtime-translate` 作正向控制；僅保存 HTTP status、request id、時間與已遮罩的 error code。
3. 404／無權限只否定「此 Platform project 可用」；200 仍**不**證明 `/v1/live` 是支援端點。
4. 若無公開文件或 OpenAI 書面確認，停止；不要為確認而呼叫未文件化 `/v1/live` 或 ChatGPT backend。

### 7.2 僅供 Codex 內部／授權環境的兩 session app-server + WebRTC P0

這不是 TransLive 實作或公開 API recipe；只是在已授權 Codex 環境檢查原始碼所述流程。

1. 用 `codex app-server --stdio`，送 `initialize` 並宣告 `capabilities.experimentalApi: true`；不要開 unsupported listener。
2. 建立 **兩個不同 `threadId`**（同一 thread 的第二次 start 會先 stop 第一次）。
3. 每個瀏覽器／Windows WebRTC `RTCPeerConnection` 加一條來源 audio track，建立各自 SDP offer。
4. 對每個 thread 呼叫 `thread/realtime/start`，帶 `transport:{type:"webrtc",sdp}`、`version:"v3"`、`outputModality:"audio"`；
   `prompt` 只可視為 Codex instructions，不能視為翻譯設定。
5. 分別等 `thread/realtime/sdp`，將 answer 設回各自 peer connection；各自播放 remote audio track。
6. 觀察 V3 transcript/audio events，停止時各自 `thread/realtime/stop`；記錄是否成功、首音訊時間與 cleanup。
7. 絕不把成功解讀成普通 API key entitlement、可分發 OAuth、或雙向翻譯品質證明。

### 7.3 TransLive 真正的最小可行計畫（公開路徑）

- 後端以標準 Platform key 呼叫
  `POST /v1/realtime/translations/client_secrets`，設 `model:"gpt-realtime-translate"` 與 `audio.output.language`；
  僅把短期 client secret 給 Windows client。官方範例與 auth 要求見
  [翻譯指南](https://developers.openai.com/api/docs/guides/realtime-translation)。
- Windows 直接採 WebRTC：每個來源音軌建立一個 translation call，接回遠端翻譯音軌；
  server media pipeline 才採 WebSocket/24 kHz PCM16。
- 雙向通話建立**每方向一個公開 translation session**，保留音軌分離、回音抑制與各自 target language。
- session 結束送 `session.close`，等 `session.closed` 再關閉，避免漏掉 draining 的輸出。

## 8. 一天 P0 spike checklist 與架構決策

- [ ] server-side mint client secret；驗證 key 不進 Windows binary、repo、telemetry、crash dump。
- [ ] 單向 WebRTC：mic/測試音檔 → translated remote track + source/target transcript。
- [ ] 驗證 `audio.output.language`，測兩個實際語言 pair、姓名／數字／快語速。
- [ ] 雙向兩 session：兩條獨立 source track、無交叉餵回／echo、可各自 mute/volume。
- [ ] 量測 first translated audio、end-of-utterance、p50/p95、丟包、reconnect、close flush；不預設次秒。
- [ ] 以 `GET /v1/models` 控制實驗記錄 GPT-Live 不可用／未知，且禁止 `/v1/live`、ChatGPT OAuth wrapper。
- [ ] 完成後以人工雙語 review 做 go/no-go；不要以「socket 連上」取代翻譯品質驗收。

**架構決策：依使用者要求，P0 採 Codex app-server + GPT-Live V3 驗證，但不得直接視為 production 架構。**
先以兩個不同 thread、兩個 WebRTC connection 驗證中→英與英→繁中 instructions、並行 entitlement、音訊路由及實測延遲；`gpt-realtime-translate` 保留為公開 API 的控制組與 production fallback。只有在 OpenAI 對 `gpt-live-1-codex`、`/v1/live`、認證／entitlement、support 與商業使用給出公開文件或書面確認後，才可把 GPT-Live 升格為正式產品依賴。

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "僅新增一份授權研究報告；未寫實作碼，未修改既有架構報告。"
    },
    {
      "id": "criterion-2",
      "status": "satisfied",
      "evidence": "報告固定 Codex SHA、提供原始碼 line permalinks、官方 API 文件、歷史/release、可重現 P0 與明確 blocker。"
    }
  ],
  "changedFiles": [
    ".scratch/research/codex-gpt-live-implementation.md"
  ],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "GitHub REST/raw source retrieval at 7625343977154efed8c0dadba956374992a1580b",
      "result": "passed",
      "summary": "固定 main SHA 並讀取 core、API、app-server protocol、history/release 與 LICENSE。"
    },
    {
      "command": "Official OpenAI documentation/spec retrieval",
      "result": "passed",
      "summary": "驗證 gpt-realtime-translate、translations endpoint、client secret、WebRTC/WebSocket 文件。"
    },
    {
      "command": "git diff --check && git diff --cached --name-only",
      "result": "not-run",
      "summary": "此研究執行環境沒有 shell/git 執行工具；寫入工具不會 stage 檔案。"
    }
  ],
  "validationOutput": [
    "所有高承載結論均附官方來源；GPT-Live 的公開 entitlement 被明確保留為未證實，而非由字串存在推論。"
  ],
  "residualRisks": [
    "未以任何憑證呼叫未文件化 /v1/live 或 ChatGPT backend，故無法也不聲稱驗證其實際 entitlement。",
    "無法透過本環境 shell 獨立列出既有 git index；本次寫入本身未 stage 檔案。"
  ],
  "noStagedFiles": true,
  "diffSummary": "新增一份 Traditional-Chinese、主來源釘選的 GPT-Live 可行性研究報告。",
  "reviewFindings": [
    "blocker: gpt-live-1-codex 與 /v1/live 沒有可確認的公開 Platform contract；不得作為 TransLive production 依賴。"
  ],
  "manualNotes": "依授權只寫入 .scratch/research；父協調器會在 review 後複製至 docs/research/codex-gpt-live-implementation.md。"
}
```
