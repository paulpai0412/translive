# Obsidian 知識庫會議助理:第三條口播 session 定案

- **定案日期:2026-09-01**
- **前篇:** [teams-zoom-gpt-realtime-obsidian-meeting-agent.md](teams-zoom-gpt-realtime-obsidian-meeting-agent.md)(平台可行性、同意模型、vault schema)
- **問題:** 在 TransLive 既有 TX/RX 翻譯 session 之外,加一條知識庫問答 session:喚醒 → 檢索 Obsidian vault → gpt-live 口播化回答 → 語音送進會議。不影響原翻譯、不掛 Teams bot。
- **結論:** 獨立 gpt-live session(文字進、語音出)+ TX 出口 Web Audio 混音 fan-in + 直讀 vault 檔案系統 FTS5 檢索。零新增外部服務依賴(無 Teams app、無 Obsidian plugin、無 agent 框架、無向量 DB)。

## 1. 定案架構

```
TX 翻譯 session ──final transcript──→ WakeGate(只聽 TX,只比對 final 文字)
RX 翻譯 session ──(不參與喚醒)               │ regex: /^(hey |ok )?translive[，,\s]+(.+)/i
                                             ▼
                              ┌────────────────────────────┐
                              │ KB session(獨立 gpt-live)   │
                              │ 輸入 = 問題文字(已是文字,    │
                              │   不重聽音訊)               │
                              │ 工具 = 3 個唯讀(見 §3)      │
                              │ instructions = 口播化改寫:  │
                              │   不照念、先結論、≤20 秒、   │
                              │   語言 = TX target language │
                              └──────────────┬─────────────┘
                                             │ audio
   TX 翻譯 audio ──→ [GainNode TX] ──┐        │
                                     ├─→ [Mixer] → MediaStreamDestination → RTCRtpSender → Teams
   KB 口播 audio ──→ [GainNode KB] ──┘

   答案文字同時 → 本機面板(含引用)+ meeting.md `assistant-answer` audit entry
```

### 四條隔離線(不影響原翻譯)

| 干擾路徑 | 隔離作法 |
| --- | --- |
| session context | TX/RX/KB 各自獨立,KB 答案永不進翻譯上下文(RX 重複 bug 教訓:任何回注文字都會出事) |
| 音訊 track | 出口 mixer fan-in,不用 `replaceTrack`;TX 程式碼一行不改 |
| 使用者插話 | barge-in:TX 側偵測到使用者開口 → 對 KB session 發 `response.cancel`,翻譯永遠優先 |
| 自我觸發迴圈 | KB 答案經 RX 回收是正常(遠端聽到的),但 WakeGate **只聽 TX**,且 KB 播放期間武裝暫停 |

### 為何不共用 TX/RX session 回答

1. 翻譯 session 的 context 是共享的,塞入問答會讓模型開始「翻譯答案」或把檢索內容混進翻譯流。
2. Realtime session 是 turn-based,回答進行中使用者的翻譯會被打斷或卡住。
3. 翻譯 session 掛上 vault 工具後,會議環境語音可能誤觸發工具呼叫。

### 生命週期與延遲

- KB session 於會議開始時建立、閒置保持(一條 WebSocket);閒置被斷則下次喚醒時重連(~1–2s)。
- 喚醒→開口目標 <6s:文字 gate(~0ms)→ 本地檢索(<100ms)→ 生成+首音訊(~2–4s)。

## 2. 為何不需要 agent

「Agent」(自主多步規劃迴圈)在此是過度設計。本情境是單輪檢索問答:喚醒 → 檢索 → 回答,1–2 次工具呼叫結束。gpt-live 的 function calling 已足夠,工具固定 3 個唯讀、無 write/shell/network;vault 內容一律視為 untrusted data,永不當指令(沿用 summary-service 的 prompt-injection 隔離模式)。

## 3. Obsidian 檢索:直讀檔案系統 + FTS5

### Obsidian「API」現況(2026-09-01 查)

| 途徑 | 本質 | 判定 |
| --- | --- | --- |
| **檔案系統** | vault = 純 markdown,官方保證格式,Obsidian 關著也能查 | **採用** |
| Local REST API plugin(`coddingtonbear/obsidian-local-rest-api`,MIT) | Obsidian 內 HTTPS + API key;simple search / JsonLogic | 僅需要 Dataview 語法時考慮;前提 Obsidian 開著,不作依賴 |
| Obsidian 內部 plugin API | 只存在 Obsidian 進程內 | Electron 用不到 |
| MCP 橋(見 §5 審計) | 全是 Local REST API 的橋 | 不採用 |

### 索引設計(已在 TransLive 環境實測)

Electron 44 內建 Node v24.18.1,`node:sqlite` + FTS5 免 flag、零新依賴:

```sql
CREATE VIRTUAL TABLE vault_idx USING fts5(
  path, heading, body,          -- 索引單位 = heading section(chunk),非整篇
  tokenize = 'trigram'          -- 中英通吃的關鍵
);
-- frontmatter 另建普通 table: path, type, date, project, tags
-- 查詢: metadata filter → vault_idx MATCH ? ORDER BY bm25(vault_idx) LIMIT 6
```

- **兩段式:** 先 frontmatter deterministic filter(type/date/project),再 FTS MATCH;bm25 排名內建。
- **chunk 級:** path + heading + line offset 天然是 citation,回 top-6 chunks 而非整篇。
- **新鮮度:** `fs.watch` 增量;5k 篇全量重建 <1s,查詢 <10ms。
- **實測坑:** trigram 查詢**至少 3 字元**,中文兩字詞(如「延後」)會 miss → <3 字 CJK 詞改走 `LIKE '%詞%'` 兜底(幾 MB 全掃毫秒級)。
- **vault 路徑**由 Electron 主進程持有與驗證,renderer 不碰。

### KB session 工具契約

| 工具 | 行為 |
| --- | --- |
| `search_vault(query, filters)` | metadata filter + FTS/LIKE + bm25,回 ≤6 chunks(path/heading/offset) |
| `read_note(path, heading)` | 直讀單篇 |
| `search_meeting_transcript(query \| last_n_minutes)` | 本場 transcript journal,支援「總結剛才五分鐘」 |

## 4. 明確不做的事

| 項 | 原因 |
| --- | --- |
| Teams 聊天 bot | 需 Teams app 註冊 + RSC + tenant 同意 + 逐會議安裝,**外部 tenant 不可行**;vault 引用路徑對遠端無意義;audit 已由 meeting.md 承擔 |
| 操控 Teams 白板 | **無即時寫入 API**(只有管理/匯出);媒體 bot 也收不到 whiteboard stream(官方 samples issue [#387](https://github.com/microsoftgraph/microsoft-graph-comms-samples/issues/387));頂多會後 `Export-WhiteboardHtml`(delegated Files.Read)匯出快照進 vault |
| UI automation 代操作 | 前篇已定:PoC only,永不當 production |
| 向量/embedding 搜尋 | FTS + metadata filter 先上;召回不足時 P2 再評估本地多語小模型 hybrid(YAGNI) |
| ducking(KB 開口壓低 TX gain) | 常態兩路不同時響;需要再加 |
| RX 側喚醒(遠端喊 translive) | 等於開放「任何人觸發你的 vault」;預設不做 |
| 多輪 S2S 對話 | 單輪先驗價值;多輪是 P2 之後 |

## 5. GitHub 套件審計(2026-09-01,GitHub REST metadata)

| Repo | 授權 | 狀態 | 判定 |
| --- | --- | --- | --- |
| `MarkusPfundstein/mcp-obsidian` | MIT | 活躍 | 參考;引入 Python runtime,不用 |
| `cyanheads/obsidian-mcp-server` | Apache-2.0 | 活躍 | 參考;TS,但仍是 Local REST API 橋 |
| `jacksteamdev/obsidian-mcp-tools` | MIT | **archived** | 排除 |
| `coddingtonbear/obsidian-local-rest-api` | MIT | 活躍 | 僅 Dataview 需求時的可選增強 |
| `logancyang/obsidian-copilot` | **AGPL-3.0** | 活躍 | 排除(授權污染發布) |
| `brianpetro/obsidian-smart-connections` | 無明確授權 | 活躍 | 排除(不可重用碼) |

## 6. 發布門檻(沿用前篇 §3)

1. 每場會議開始前明示:capturing / transcribing / sending to OpenAI / writing vault,預設 off。
2. KB 語音回答進會議前:AI-voice 揭露(OpenAI TTS guide 要求);答案模式預設「本機先審、一鍵送出」,armed 全自動是使用者明確簽收的風險。
3. 資料最小化:預設不留 raw audio;transcript 為 untrusted data。

## 7. 驗收條件

1. 會議中 TX 翻譯進行時觸發 KB 問答,翻譯字幕與語音無中斷、無錯段。
2. KB 答案口播非照念 markdown,含來源引用;找不到證據時回答「已索引記錄中找不到」。
3. KB 播放期間使用者插話,KB 立即停止、翻譯無縫接續。
4. KB 答案出現在 RX 轉錄(遠端視角正常),但不觸發新一輪喚醒。
5. Obsidian 未開啟時 vault 搜尋照常;中文兩字詞可查(「延後」類)。
6. 全部答案落 meeting.md audit entry,刪除 session 時一併清除索引與產物。
