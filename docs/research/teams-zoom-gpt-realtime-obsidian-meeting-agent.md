# Teams / Zoom × GPT Realtime × Obsidian 會議助理：可行性與最小路徑

- **調查日期：2026-08-31**
- **問題：**以目前 TransLive 為基礎，能否由行事曆或連結進入 Teams／Zoom 會議，持續轉錄、摘要、落盤 Obsidian 知識圖譜，並在喚醒詞後檢索及語音回答？
- **結論：**可做，但不能把「任意連結→靜默 bot 加入→取得所有音訊」當作共通能力。推薦先做**明示錄音、使用者在本機已加入會議、透過既有虛擬音訊路由擷取的桌面助理**；它能涵蓋 Teams 與 Zoom，並避免把 MVP 綁在 Teams Calling 與 Zoom Marketplace／RTMS 核准。正式平台整合應分流：Teams 走 Graph post-meeting transcript 或受限的 Azure/C# media bot；Zoom 優先評估 RTMS。 

所有「事實」下列皆連至來源擁有者的官方文件或官方 GitHub。未列為事實的設計選擇是本報告的推論。

## 1. Repo reuse audit

### 已存在、應重用

| 現有項目 | 已驗證的行為 | 對本案的用途 |
|---|---|---|
| `src/records-store.js` | 以 stage directory + `rename()` 寫入完整 session/summary package；有 SHA-256 manifest、序列化 mutation queue、明文逐字稿顯式 consent、retention 上限、刪除／匯出。 | 抽出或擴充為 `VaultWriter` 的可靠寫入基礎；不要另造一套非原子的檔案儲存。 |
| `src/summary-service.js` / `summary-controller.js` | 只接受明確確認才把 transcript 交摘要模型；摘要輸出有固定 sections、每項必須引用 session + offset，並在 abort 時 rollback。 | 保留「證據引用、prompt-injection 隔離、先確認外送」模式；模型實作替換成正式 OpenAI API，不要重用 Codex 非公開 transport。 |
| `src/dual-channel-run.js`、`phase-one-controller.js`、Windows audio controllers | 已有 physical mic、virtual cable、headphone endpoint 分離、互斥檢查、run lifecycle 和 stop cleanup。 | 本機 MVP 的 Teams/Zoom ingress 基座；另建會議擷取模式，而非改動翻譯 run 的既有安全假設。 |
| `src/records-path.js` / Electron 主行程 IPC | 已把 local data path、明確 IPC surface、context isolation/sandbox、dialog export 接起來。 | vault path 僅由主行程取得與驗證；renderer 不得可任意寫檔。 |
| `docs/research/codex-gpt-live-implementation.md` | 已正確將 `gpt-live-1-codex`／`/v1/live` 定位為 Codex source 可見但**非公開 Platform contract**。 | 不可把既有 `CodexSummaryService` 或 Phase 1 的 GPT-Live transport 升格為本案 production 依賴。改用已文件化 Realtime / Audio API。 |

### 現有阻礙／不應沿用

- `package.json` 只有 Electron 44 與 packager；目前沒有 Microsoft identity、Graph、Zoom SDK、OpenAI SDK 或向量 DB 依賴。MVP 不必先加一個 RAG DB：以 vault Markdown + bounded in-memory / local index 足夠做一個人、少量會議的驗證。
- `PhaseOneController` 固定 `gpt-live-1-codex` 和 Codex app-server。依既有研究，該面向是 experimental／未公開；本功能改用官方公開的 `gpt-live-transcribe`、`gpt-realtime-2.1` / Audio TTS surface。
- 現有 `RecordsStore` 是「完成 session 後整包 commit」；即時 meeting note 需要 append-safe journal 或 immutable segment 檔，不能每個 partial transcription 覆寫同一個 `.md`。

## 2. 平台可行性矩陣

| 路徑 | 可加入既有會議？ | 音訊 ingress／speaker | 語音 egress | MVP 判定 | 主要限制／一手來源 |
|---|---|---|---|---|---|
| **本機已加入的 Teams/Zoom + OS/virtual-audio capture** | 使用者自己以正式 client 加入；agent 不冒充 participant。 | 可捕捉本機會議輸出與自己麥克風；speaker identity 不是平台保證。 | 播到本機耳機；若要送進會議須使用者明確 unmute／選擇 virtual mic。 | **推薦 P0/P1** | 跨平台、最少核准；但錄音合法性與每場告知仍是產品責任，且 UI／device route 脆弱。 |
| **Teams 普通 messaging bot** | 可被安裝／互動，但不是 raw media 通道。 | 無可主張的連續 raw meeting audio。 | chat/card 為主。 | 不作轉錄 ingress | Teams 文件把 service-hosted media 限為 `PlayPrompt`、`Record`、DTMF；直接 media 是另一個 app-hosted 類型。 [Teams overview](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/calls-and-meetings/calls-meetings-bots-overview) |
| **Teams service-hosted calling bot** | Graph 可 create call / join scheduled meeting，需 application permission 與 meeting coordinates。 | Microsoft 代管 media；文件化能力為 play prerecorded prompt、record clip、DTMF，不是本機 PCM streaming。 | 預錄音 prompt。 | 不適合 Realtime loop | [Create call](https://learn.microsoft.com/en-us/graph/api/application-post-calls?view=graph-rest-1.0)、[Teams overview](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/calls-and-meetings/calls-meetings-bots-overview) |
| **Teams app-hosted Cloud Communications media bot** | Graph 文件支援 join existing scheduled meeting；仍需 bot registration、application permissions/admin consent、meeting coordinates，並受 lobby／tenant policy 實際結果約束。不是「只給 URL 就任意靜默加入」承諾。 | raw audio/video；Teams doc 指 audio 為 16 kHz、16-bit，20 ms frame；可取得 active/dominant speakers。 | bot 可送 audio；需處理 echo/turn-taking。 | **P3 enterprise spike** | 額外 `Calls.AccessMedia.All`；只支援 C#/.NET，production 在 Azure Windows Server，public VM endpoint，VM-pinned calls；Node/Electron 不可直接承載。 [Real-time media](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/calls-and-meetings/real-time-media-concepts)、[requirements](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/calls-and-meetings/requirements-considerations-application-hosted-media-bots) |
| **Teams policy-based compliance recording** | 由 tenant policy / application instance 針對被錄使用者，不是 consumer assistant 的任意入會方式。 | 錄製／保存 raw media。 | 非本案對話 bot 路徑。 | **排除 MVP** | Microsoft 明定此 solution 只支援 policy-based compliance recording，其他用途不支援；需 certified third-party partner、Azure Windows VM、policy 與使用者通知。 [Compliance recording](https://learn.microsoft.com/en-us/microsoftteams/teams-recording-compliance)、[recording status](https://learn.microsoft.com/en-us/graph/api/call-updaterecordingstatus?view=graph-rest-1.0) |
| **Teams post-meeting Graph transcript** | 不入會；讀已存在 transcript。 | VTT 可有 timestamp + `<v Speaker>`，但 tenant 可禁 speaker attribution 或完全禁 Graph transcript access。 | 無。 | **Teams P2 fallback / enrichment** | `OnlineMeetingTranscript.Read.All` 或 RSC；application path 另需 admin application access policy。 [Get callTranscript](https://learn.microsoft.com/en-us/graph/api/calltranscript-get?view=graph-rest-1.0) |
| **Zoom Meeting SDK** | 同 developer account meeting 以 SDK JWT participant join；外部 account 需 Zoom review 以及 ZAK 或 OBF。OBF 對應 OAuth user 必須已在場，且 user 離場 app 必須離場。 | 是嵌入 Zoom client，不應假定它提供可任意抽取的 server-side PCM。 | 可作可見 participant UI／meeting client 行為。 | P3；只限核准場景 | [Meeting SDK authorization](https://developers.zoom.us/docs/meeting-sdk/auth/) |
| **Zoom Video SDK** | **不能**加入 Zoom Meetings/Webinars；只可建立／加入同一 Video SDK account 的 on-demand sessions。 | 自有 session media。 | 自有 session media。 | 不用於現有 Zoom meeting | [Video SDK auth](https://developers.zoom.us/docs/video-sdk/auth/)、[session lifecycle](https://developers.zoom.us/docs/video-sdk/web/sessions/) |
| **Zoom RTMS** | 對 Zoom meetings/webinars server-side media；需 app、RTMS scopes、Developer Pack credits與啟動模式／授權流程，須用 real account spike 確認 organizer、OAuth install、meeting setting 和 REST-on-demand 條件。 | per-participant/merged 16 kHz mono L16 PCM；participant id/name/timestamp；官方 transcript 有 attribution/diarization。 | RTMS 是 ingest，不是 bot speech output。 | **Zoom P2/P3 首選** | 不需 device/bot 軟體但不是無授權任意取得會議資料。 [RTMS getting started](https://developers.zoom.us/docs/rtms/meetings/getting-started/)、[media](https://developers.zoom.us/docs/rtms/meetings/media/) |
| **Browser/desktop UI automation** | 技術上可點 client UI；非受支援的 platform integration。 | 易被 UI、A/B test、login/MFA、lobby、captions、OS permission、DPI / locale 破壞。 | 同上。 | **PoC only，永不當 production ingress** | 此風險是工程推論：沒有 Microsoft/Zoom 將 UI automation 指定為 meetings media API。不可藉此繞過 marketplace、owner、tenant、consent 或 recording policy。 |

### Teams 的精確界線

1. Graph `POST /communications/calls` 說明可 create outgoing call 或 join existing meeting；該 API **只支援 application permissions**，而 app-hosted media 還要 `Calls.AccessMedia.All`。其 scheduled-meeting 範例需要 thread ID、message ID、organizer ID、tenant ID；不是 bare join URL 的產品保證。 [官方 API](https://learn.microsoft.com/en-us/graph/api/application-post-calls?view=graph-rest-1.0)
2. 若保存任何 Media Access API 取得的 media 或衍生資料，Microsoft 規定先 `updateRecordingStatus` 成功；開始錄製前／結束後要正確切狀態。 [官方 API](https://learn.microsoft.com/en-us/graph/api/call-updaterecordingstatus?view=graph-rest-1.0)
3. Compliance route 的通知是正式功能而非可選 UX：被 policy 指派的使用者會得視覺／音訊 recording notice；Microsoft 只支援 listed certified partner solutions。 [Teams compliance recording](https://learn.microsoft.com/en-us/microsoftteams/teams-recording-compliance)

## 3. 授權、啟動與同意模型

### Calendar / link

- **Microsoft 365 calendar：**桌面 client 做 authorization-code + PKCE；P1 request 最小 delegated `Calendars.Read`（`Calendars.ReadBasic` 不保證取得 meeting body/join link）與明確 `offline_access`。`GET /me/events` 列出資料的 delegated least-to-most scopes 為 `Calendars.ReadBasic`, `Calendars.Read`, `Calendars.ReadWrite`；Microsoft identity platform 明示 v2 endpoint 必須顯式要求 `offline_access` 才收 refresh token。 [List events](https://learn.microsoft.com/en-us/graph/api/user-list-events?view=graph-rest-1.0)、[offline_access](https://learn.microsoft.com/en-us/entra/identity-platform/scopes-oidc#the-offline_access-scope)
- **不要用 app-only calendar 讀取當 MVP：**application permissions 是 daemon direct access，權限面比「登入本人 calendar」寬；除非 enterprise 管理員明確要求排程 bot 才另作 consent / access-policy 設計。 [Microsoft permissions model](https://learn.microsoft.com/en-us/entra/identity-platform/scopes-oidc)
- **連結啟動：**接受 Teams/Zoom link 作為 untrusted input；只允許官方 hostname allowlist、顯示 destination/meeting subject、讓使用者按「Open and start assistant」。不解析密碼／token 到 log、note frontmatter 或 analytics。
- **Zoom：**會議連結本身不是 OAuth／Meeting SDK／RTMS authorization。Meeting SDK 的 JWT secret 只應 server-side 產生；外部 meeting 還有 review + ZAK/OBF 約束。 [Zoom auth](https://developers.zoom.us/docs/meeting-sdk/auth/)

### 明示同意、告知與資料界線（產品要求）

本報告不提供法律意見；但以下是發布門檻：

1. **每次會議、開始前**：顯示「capturing / transcribing / sending to OpenAI / writing vault」的 platform、audio source、retention、vault path；預設 off，需確認後才開始。現有 `RecordsStore.grantPlaintextConsent()` 的一次性明文同意不夠取代逐場告知。
2. **每次啟用回答前**：顯示「AI voice」與「may answer into meeting」；OpenAI 官方 TTS guide 要求清楚揭露聽到的是 AI-generated voice。 [TTS guide](https://developers.openai.com/api/docs/guides/text-to-speech)
3. **Teams / Zoom native integration：**依平台 recording status/policy、tenant admin、organizer/meeting owner 約束；不以使用者本機 toggle 覆蓋平台要求。
4. **資料最小化：**預設只留 transcript + summary，不留 raw audio；raw audio 另選、可設 retention、加密／OS protected secret storage、delete-first UI。對匯入 prompt 的 transcript 仍採現有「untrusted data, never tool instructions」規則。

## 4. Audio / transcription / speech architecture

### 推薦兩條獨立 Realtime session

| 任務 | API / transport | 原因與界線 |
|---|---|---|
| continuous meeting transcription | `gpt-live-transcribe` transcription session over **server WebSocket** | OpenAI 文件指定 server media pipeline 用 WebSocket，24 kHz PCM input；輸出 delta / completed events。`gpt-live-transcribe` 沒有 word timestamps、speaker labels 或 confidence，不能假稱 diarization。 [Realtime transcription](https://developers.openai.com/api/docs/guides/realtime-transcription)、[overview](https://developers.openai.com/api/docs/guides/realtime) |
| wake-word question + spoken answer | `gpt-realtime-2.1` voice-agent session（或 transcription → text/RAG → TTS chained flow） | 功能工具可由 application 執行，回傳 `function_call_output`；私有 vault/RAG 不交給 arbitrary remote MCP。若必須逐步審核或引用，官方 guide 指 chained speech-to-text → reasoning → TTS 比 speech-to-speech 更可控。 [Realtime tools](https://developers.openai.com/api/docs/guides/realtime-mcp)、[voice agents](https://developers.openai.com/api/docs/guides/voice-agents) |

**不要混成一條 session。**持續轉錄不應在每段語音自行回話；answer session 也不應看到整個未審核長會議環境。共享的是已 final 的、帶 provenance 的 transcript segments。

### Ingress normalization

- **Desktop MVP:** capture mix / each available route → resample mono PCM16 24 kHz → bounded queue → Realtime WS `input_audio_buffer.append`。上游是 Teams app-hosted / Zoom RTMS 時，將其 16 kHz PCM 正規化到相同 adapter；RTMS 的 L16 is 16 kHz mono，per-participant data 含 id/name/timestamp。 [Zoom RTMS media](https://developers.zoom.us/docs/rtms/meetings/media)
- **VAD:** transcription session 可用 `server_vad`（threshold/prefix/silence tunable）或 `semantic_vad`；VAD 只決定 chunk boundary，不能當喚醒詞／speaker identity。 [Realtime VAD](https://developers.openai.com/api/docs/guides/realtime-vad)
- **Partial vs final:** UI 可顯示 deltas；只有 completion（依 `item_id` reconcile，跨 turn completion ordering 不保證）才進 durable segment 與 summary queue。 [Realtime transcription](https://developers.openai.com/api/docs/guides/realtime-transcription)
- **Diarization:**
  - best: Zoom RTMS per-user PCM/transcript 或 Teams Graph VTT speaker tag；
  - medium: Teams media active-speaker metadata（需實作 spike）；
  - desktop mix: `speaker: unknown`，**不得**從 OpenAI transcript 推斷官方 speaker identity。`gpt-live-transcribe` 不回 speaker labels。 [Teams real-time media](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/calls-and-meetings/real-time-media-concepts)、[OpenAI transcription](https://developers.openai.com/api/docs/guides/realtime-transcription)

### Wake gate and RAG

**MVP gate = final transcript text phrase match，不上 hotword SDK。**例如 `/^(?:hey |ok )?translive[，,\s]+(.+)/i`，須再有 local push-to-talk 或 UI armed toggle；只有 meeting host-approved mode 才允許送音訊 egress。這不是安全邊界，而是成本／誤觸發 gate。

流程：

1. transcript final → check phrase → extract question；不符合只寫 transcript。
2. query local `MeetingIndex`，先以 deterministic metadata filters（owner / date / platform / tags），再 lexical BM25/FTS；回傳最多 6 段、每段有 note path + heading + timestamp。
3. Realtime function `search_meeting_notes(query, filters)` 只可讀該 allowlisted vault；模型取得 evidence 後產生短答。禁止 write、shell、network、calendar mutation tool。
4. 先在本機顯示 answer + citations，使用者或 meeting policy 才決定播放；答案應口述來源／不確定性，並在 note 留 `assistant-answer` audit entry。
5. model 不能找到 evidence 時回答「我在已索引記錄中找不到」，不能補完。

可選 on-device wake engine 候選是第三方 Picovoice Porcupine（見候選表），但不是 P0；其 access key、keyword model、false accept/reject、Electron native binary 和 license/terms 都要另 spike。

## 5. Obsidian vault schema 與原子寫入

Obsidian 把 notes 存成 vault 中的 Markdown plain-text files，並自動反映 external changes；properties 是檔首 YAML；YAML property 的 `[[internal link]]` 必須加 quotes。 [How data is stored](https://github.com/obsidianmd/obsidian-help/blob/master/en/Files%20and%20folders/How%20Obsidian%20stores%20data.md)、[Properties](https://github.com/obsidianmd/obsidian-help/blob/master/en/Editing%20and%20formatting/Properties.md)

### 建議檔案布局（human-readable、portable）

```text
<vault>/Meetings/
  2026/2026-08-31 Acme weekly — teams — <stable-id>/
    meeting.md                 # canonical human note
    transcript.ndjson          # immutable final segments / recovery journal
    summary.md                 # optional generated detail
  People/Alice Chen.md         # only user-confirmed canonical identity
  Projects/Acme.md
  Decisions/<slug>.md
  Actions/<slug>.md
```

`meeting.md`（名稱中的 `stable-id` 防同標題 collision）範例：

```md
---
type: meeting
id: "uuid-or-platform-stable-id"
started: 2026-08-31T09:00:00+08:00
ended: null
platform: teams
source: desktop-capture # desktop-capture | zoom-rtms | teams-transcript
consent: explicit-per-meeting
speaker_attribution: unknown # platform | inferred | unknown
participants:
  - "[[People/Alice Chen]]"
projects:
  - "[[Projects/Acme]]"
tags: [meeting, platform/teams]
---

# Acme weekly — 2026-08-31

## Live transcript
- 09:03:12 — **Unknown**: ... ^seg-000042

## Summary
- Decision: ... [^seg-000042]

## Actions
- [ ] [[Actions/Prepare rollout]] — owner: [[People/Alice Chen]] — due: 2026-09-05 [^seg-000042]

## Links
- [[Projects/Acme]]
- [[Decisions/Rollout date]]
```

Rules:

- Build wikilinks only from canonical, user-confirmed entities. New people/entity names first remain plaintext candidates, preventing accidental graph pollution and path/Markdown injection.
- Store platform IDs/tokens only in non-published local sidecar encrypted by OS secret storage; never frontmatter. `meeting.md` has no join link by default.
- Use frontmatter values as atomic facts, not nested arbitrary model JSON; attach raw structured data as `summary.json` sidecar if needed.

### Writer protocol

1. Make a session folder once (`mkdir`); write each finalized segment as one JSONL/NDJSON line with fsync discipline where host OS supports it.
2. A single writer queue folds final segments into full Markdown temp file in the *same directory*; `fsync` temp, `rename(temp, meeting.md)`, then fsync directory where available. Never stream partial deltas directly to `meeting.md`.
3. Maintain `manifest.json` with schema/version/content hash like `RecordsStore`; on recovery, rebuild note from transcript journal. Reuse its existing stage-folder replacement semantics for final summary package.
4. Watch only the app’s own output path; if Obsidian/user changes `meeting.md`, stop overwrite and surface a merge conflict. Obsidian refreshes external changes, so a competing writer is a real data-loss risk. [Obsidian storage](https://github.com/obsidianmd/obsidian-help/blob/master/en/Files%20and%20folders/How%20Obsidian%20stores%20data.md)

## 6. Recommended minimum phased MVP

### P0 — local, visible assistant; no platform bot (smallest useful release)

- Manual Teams/Zoom link open and manually armed local capture; show persistent red **Recording / OpenAI transcription active** status and live partial captions.
- Replace only the capture→transcription path with documented `gpt-live-transcribe` WS; retain existing Windows route validation/lifecycle, record final segments into `RecordsStore`-style package.
- End meeting: deterministic summary prompt with segment citations → atomic Obsidian note; no automatic person/entity notes except explicitly confirmed project link.
- Search UI/text only; wake phrase merely displays a proposed answer locally. No automatic meeting egress.
- **Acceptance:** user can join one Teams and one Zoom meeting normally, sees final transcript without loss across reconnect, gets a single atomic vault note with source offsets, and deletion removes both index and generated artifacts.

### P1 — calendar + guarded spoken retrieval

- Entra delegated calendar read + `offline_access`; upcoming-meeting picker and manual confirm to open link/start assistant.
- Start separate voice-agent/chained session only after text gate + local PTT. Function tool only queries local meeting index; spoken output goes **headphones by default**. Add explicit "send answer to meeting once" action and AI-voice disclosure.
- **Acceptance:** ask “TransLive, what were last meeting’s open actions?”; answer contains note/timestamp evidence or an honest no-result; transcript words cannot trigger any write/network tool.

### P2 — platform-native enrichment, not universal bot promise

- Teams: Graph post-meeting transcript import when tenant/app consent/policy permits; preserve `text/vtt` speaker metadata where accessible, fall back on 403 policy codes.
- Zoom: RTMS spike for an account-owned, organizer-authorized meeting; normalize per-person audio/transcripts.
- **Acceptance:** demonstrate one authorized tenant/account for each integration, document all scopes/consents/owner steps, and show precise failure UX for permission/lobby/attribution denial.

### P3 — enterprise bot routes (separate deployable, not Electron feature flag)

- Teams app-hosted media: Azure Windows/.NET service, Graph Calling permissions, recording-status handling, tenant admin approval and platform support review.
- Zoom Meeting SDK only for approved external meeting UX; RTMS for server ingest. No UI automation fallback.
- **Acceptance:** legal/security/platform approval, runbook, load/reconnect/recording-notice validation, and explicit market/tenant eligibility matrix.

## 7. Target architecture / data flow

```text
[Calendar delegated OAuth] --events/link--> [Electron main: explicit Start]
                                             |          |
  Teams/Zoom official client ----------------+          +--> [normal browser/native join]
  (P0 local virtual audio) --> [CaptureAdapter] --PCM--> [bounded resample/segment queue]
  (P2 RTMS/Teams service) ---^                              |
                                                            v
                                           [Realtime transcription WS]
                                      partial --> caption UI only
                                      final --> [provenance segment journal]
                                                   |             |
                                                   v             v
                                      [local index / RAG]   [atomic VaultWriter]
                                                   ^             |
  wake phrase + PTT --> [policy gate] --> [read-only function]  v
                                      [voice answer / headphones] Obsidian Markdown + wikilinks
```

Security boundaries: renderer is untrusted relative to vault credentials; main process owns vault allowlist and OAuth token store; backend owns OpenAI/Zoom signing secrets and only mints short-lived client credentials where browser media is later used; transcript content is untrusted data, never executable instructions.

## 8. Key risks and falsification spikes

| Risk | Why it matters | Required spike / exit condition |
|---|---|---|
| Teams raw media scope/platform eligibility | Node/Electron cannot host official app-hosted media; Azure Windows/.NET requirement and permission/admin policy make this a different product. | C# sample in test tenant creates/joins organizer-owned scheduled meeting, calls recording status before persistence, measures raw audio + bot presence/lobby. Stop if tenant policy / support path fails. |
| Zoom authorization | External Meeting SDK and RTMS capabilities are account/approval/settings dependent. | Use two accounts: owner + external; verify approved app / OAuth / ZAK or OBF / RTMS scope & credits / organizer flow. Capture no customer media. |
| Desktop capture reliability | OS device defaults, virtual driver install, Teams/Zoom audio settings, echoes. | Automated device enumeration + manual E2E: 30 min Teams/Zoom, headset, mute/reconnect/quit recovery; assert no output audio feeds input. |
| Diarization accuracy | Local mix has no trustworthy identity; wrong attribution damages knowledge graph. | Test named multi-speaker audio. Require platform-provided identity or label unknown; do not ship ML identity guessing as fact. |
| Latency/quality | OpenAI says delay settings trade latency vs quality and exact ms vary; no assumed sub-second SLA. | Define p50/p95 caption latency and WER-like human eval over target languages, accents, code-switching, numbers, domain terms, noisy audio. [Official guidance](https://developers.openai.com/api/docs/guides/realtime-transcription) |
| Wake false trigger / disruption | A model response may interrupt a meeting or leak prior-meeting private facts. | Begin PTT-only, local headphone playback. Measure false accepts; only later enable exact phrase + host-approved one-shot egress. |
| Vault race/corruption | Obsidian/user/cloud sync can change same note while app writes. | Fault injection at write/rename; recovery from journal; external-change conflict UI. |
| Privacy/data residency | Audio/transcript leaves device for OpenAI; graphs can expose cross-meeting content. | Data map, retention deletion proof, account/tenant configuration review, no raw default, scoped vault index. |

## 9. GitHub portability candidates (checked 2026-08-31)

| URL | Purpose | Official? / status observed | License | Portable part | Do **not** carry over |
|---|---|---|---|---|---|
| [microsoftgraph/microsoft-graph-comms-samples](https://github.com/microsoftgraph/microsoft-graph-comms-samples) | Teams Graph Calling / local-media / policy-recording reference | Microsoft Graph official; public, non-archived; repo API reports last push 2026-02-25 | MIT | C# call lifecycle, callback, media adaptation, Azure deployment concepts | Do not copy policies/secrets/config; do not imply sample grants certification/support; Electron/Node cannot host its media SDK. |
| [zoom/meetingsdk-auth-endpoint-sample](https://github.com/zoom/meetingsdk-auth-endpoint-sample) | server-side Meeting SDK JWT example | Zoom official; public/non-archived; last push 2026-06-26 | **NOASSERTION / Other** in GitHub API—treat as reference, not copyable until LICENSE counsel review | JWT claim shape and secret-is-server-side pattern | Do not copy code without a license determination; never issue broad JWT from Electron; no bypass of external-review/ZAK/OBF rules. |
| [zoom/videosdk-auth-endpoint-sample](https://github.com/zoom/videosdk-auth-endpoint-sample) | Video SDK JWT example | Zoom official; public/non-archived; last push 2026-06-26 | **NOASSERTION / Other**—reference only | Server signing boundary | Do not use it to join Zoom Meetings/Webinars: Video SDK cannot do that; do not copy absent a license grant. |
| [openai/openai-agents-js](https://github.com/openai/openai-agents-js) | TypeScript RealtimeAgent/RealtimeSession helpers | OpenAI official; public/non-archived; last push 2026-08-28 | MIT | Realtime voice session/tool ergonomics, browser/WebRTC patterns | Do not make it a reason to expose OpenAI API key in renderer; avoid multi-agent framework for the simple local read-only RAG tool unless it removes code. |
| [obsidianmd/obsidian-help](https://github.com/obsidianmd/obsidian-help) | Canonical Markdown/YAML/link behavior reference | Obsidian official docs; public/non-archived; last push 2026-08-25 | No repository license reported | Schema compatibility knowledge only | Do not vendor documentation/content into product; it is not a vault-writing SDK. |
| [Picovoice/porcupine](https://github.com/Picovoice/porcupine) | optional on-device wake-word engine | **Third party**; public/non-archived; last push 2026-08-12 | Apache-2.0 reported by GitHub API (still inspect shipped model/access-key terms) | Native/local keyword detection concept and supported binding evaluation | Do not add before PTT/text-gate baseline; do not bundle proprietary/custom keyword assets or access key without commercial/redistribution review; native/Electron portability is a spike. |

License/status claims above are from each project’s GitHub REST repository metadata at the stated date, not from package-name mirrors. Repository source does not grant Zoom/Teams/OpenAI hosted-service permissions.

## 10. Decisions needed

1. Approve **P0 local visible assistant** as product scope, explicitly excluding automatic bots / background arbitrary joins.
2. Choose data posture: local transcript by default vs cloud transcription only with explicit per-meeting consent; set retention duration and vault location ownership.
3. Choose whether spoken answer is ever allowed into meeting before P2. Recommendation: **no**—headphones + one-shot user action only.
4. Select first enterprise target: Teams tenant with admin sponsor, or Zoom account with Developer Pack / RTMS sponsor. Do not undertake both app-hosted Teams media and Zoom Meeting SDK simultaneously.

## Primary-source index

- Microsoft: [Teams calls/meetings overview](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/calls-and-meetings/calls-meetings-bots-overview), [real-time media](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/calls-and-meetings/real-time-media-concepts), [app-hosted requirements](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/calls-and-meetings/requirements-considerations-application-hosted-media-bots), [create call](https://learn.microsoft.com/en-us/graph/api/application-post-calls?view=graph-rest-1.0), [recording status](https://learn.microsoft.com/en-us/graph/api/call-updaterecordingstatus?view=graph-rest-1.0), [call transcript](https://learn.microsoft.com/en-us/graph/api/calltranscript-get?view=graph-rest-1.0), [calendar events](https://learn.microsoft.com/en-us/graph/api/user-list-events?view=graph-rest-1.0), [OAuth offline access](https://learn.microsoft.com/en-us/entra/identity-platform/scopes-oidc#the-offline_access-scope), [compliance recording](https://learn.microsoft.com/en-us/microsoftteams/teams-recording-compliance).
- Zoom: [Meeting SDK authorization](https://developers.zoom.us/docs/meeting-sdk/auth/), [Video SDK authorization](https://developers.zoom.us/docs/video-sdk/auth/), [Video SDK sessions](https://developers.zoom.us/docs/video-sdk/web/sessions/), [RTMS getting started](https://developers.zoom.us/docs/rtms/meetings/getting-started/), [RTMS media](https://developers.zoom.us/docs/rtms/meetings/media/).
- OpenAI: [Realtime overview](https://developers.openai.com/api/docs/guides/realtime), [Realtime transcription](https://developers.openai.com/api/docs/guides/realtime-transcription), [Realtime VAD](https://developers.openai.com/api/docs/guides/realtime-vad), [Realtime tools](https://developers.openai.com/api/docs/guides/realtime-mcp), [voice agents](https://developers.openai.com/api/docs/guides/voice-agents), [TTS disclosure](https://developers.openai.com/api/docs/guides/text-to-speech).
- Obsidian: [How data is stored](https://github.com/obsidianmd/obsidian-help/blob/master/en/Files%20and%20folders/How%20Obsidian%20stores%20data.md), [Properties](https://github.com/obsidianmd/obsidian-help/blob/master/en/Editing%20and%20formatting/Properties.md).

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Only the requested research Markdown artifact was written. It narrows the MVP to explicit local capture, documented OpenAI APIs, atomic vault persistence, and read-only retrieval; it does not add code or claim arbitrary silent bots."
    },
    {
      "id": "criterion-2",
      "status": "satisfied",
      "evidence": "Repo audit, platform feasibility matrix, phased plan, data flow, spike acceptance conditions, source index, and GitHub URL/license/status/portability table are included. Load-bearing platform/API claims cite owner documentation; source checks were run in addition to direct official-page retrieval."
    }
  ],
  "changedFiles": [
    "/home/timmypai/.pi/agent/sessions/--home-timmypai-apps-translive--/subagent-artifacts/outputs/4aa6fadc-e592-4daa-a64c-78a5fd9a4ab3/docs/research/teams-zoom-gpt-realtime-obsidian-meeting-agent.md"
  ],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "Primary-source retrieval: Microsoft Learn / Graph, Zoom Developer, OpenAI docs, Obsidian official GitHub, and GitHub REST repository metadata",
      "result": "passed",
      "summary": "Retrieved and cross-checked platform authorization, media, transcription, vault-format, licensing, and maintenance facts as of 2026-08-31."
    },
    {
      "command": "Repository audit via read: package.json, main.js, records-store.js, summary-service.js, summary-controller.js, codex-runtime.js, dual-channel-run.js, phase-one-controller.js, existing docs/research",
      "result": "passed",
      "summary": "Identified reusable atomic records, consent, summary citation, Electron IPC, and Windows audio-routing foundations; identified undocumented Codex Live dependency as non-production."
    },
    {
      "command": "git diff/check/status",
      "result": "not-run",
      "summary": "No shell/git execution tool is available in this research run. The sole write is to the mandated session artifact path and did not stage files."
    }
  ],
  "validationOutput": [
    "Required sections present: repo reuse, Teams normal/service/app-hosted/compliance boundaries, Zoom Meeting/Video/RTMS limits, UI automation risk, calendar/OAuth/consent, ingress/egress/VAD/diarization/function calling/RAG, Obsidian atomic schema, matrix, phases, architecture, risks/spikes, and portability candidates.",
    "No assertion states that Teams or Zoom permits arbitrary, silent, ownerless bot joins."
  ],
  "residualRisks": [
    "No credentialed tenant/account integration was executed; exact Teams lobby/tenant policy and Zoom RTMS/Marketplace entitlement must be proven by the listed spikes.",
    "No legal determination was made for recording consent, retention, or cross-border data processing.",
    "Existing repository index state could not be independently queried without shell access; this task itself did not stage any file."
  ],
  "noStagedFiles": true,
  "diffSummary": "Created one primary-source research artifact at the authoritative path; no application code was changed.",
  "reviewFindings": [
    "blocker: Do not ship gpt-live-1-codex/Codex app-server realtime as this meeting agent's production transcription transport; use documented OpenAI Realtime APIs.",
    "blocker: Do not promise arbitrary silent Teams/Zoom bot joining. Teams media is Azure/.NET/admin/policy constrained; external Zoom Meeting SDK requires review and ZAK/OBF conditions.",
    "no other blockers for the proposed P0 local, explicitly-consented assistant."
  ],
  "manualNotes": "The runtime path override was honored exactly. The requested repo-relative docs path was intentionally not written because the authoritative output path supersedes it."
}
```