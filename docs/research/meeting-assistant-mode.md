# 會議助手模式(Meeting Assistant Mode)定案

- **定案日期:2026-09-01**(同日重新定向,取代原 Obsidian KB 助理設計)
- **前篇:** [teams-zoom-gpt-realtime-obsidian-meeting-agent.md](teams-zoom-gpt-realtime-obsidian-meeting-agent.md)(平台可行性、同意模型)
- **需求:** TransLive 新增會議助手模式。此模式**不做翻譯**,只做:記錄會議、會後匯整、會議中以喚醒詞檢索並口播回答**本場及過去儲存的會議內容與結論**。不接 Obsidian、不掛 Teams bot。
- **結論:** 重用既有雙通道擷取 + RecordsStore + 虛擬麥 egress;新增一條獨立 gpt-live 問答 session(文字進、語音出,口播化)+ FTS5 分層索引。回答預設**本機先審、一鍵送出**。零新增外部服務依賴。

## 1. 模式定位

TransLive 啟動二選一,共用音訊路由與儲存層,session 配置各自獨立、互不載入:

| 模式 | 行為 |
| --- | --- |
| 翻譯模式(既有) | TX/RX 雙向即時翻譯 |
| 會議助手模式(本文件) | 錄音轉錄 + 會後摘要 + 喚醒問答;無翻譯 session |

## 2. 架構

```
┌─ 擷取(既有雙通道機器,不跑翻譯)───────────────┐
│ 本機麥克風 ──→ 轉錄 session A ──→ 「me」字幕     │
│ 會議輸出   ──→ 轉錄 session B ──→ 「remote」字幕 │
└──────────────────┬────────────────────────────┘
                   │ final segments(帶來源標記)
                   ▼
        RecordsStore session package(既有:
        transcript journal + consent + 原子寫入)
                   │
   WakeGate(只聽「me」final 文字)
   regex: /^(hey |ok )?translive[，,\s]+(.+)/i
                   ▼
        問答 session(獨立 gpt-live,文字進語音出)
        instructions:口播化改寫——不照念、先結論、
          ≤20 秒、語言 = 問題語言
        工具:2 個唯讀(見 §4)
                   │
                   ▼
        本機面板:答案文字 + 引用(先審,見 §5)
                   │ 使用者批准
                   ▼
   真實麥 ──→ [GainNode: 原音直通,不經模型] ──┐
                                              ├─→ Mixer → 虛擬麥 → Teams
   問答答案 ──→ [GainNode: gpt-live 合成語音] ──┘
```

### 音訊界線(重要,已更正初版「單一路」的錯誤)

- Teams 只認一條麥克風 = 虛擬麥,其上 mixer 兩路:**使用者原音直通**(不經任何模型)+ **gpt-live 合成語音**(只播口播稿)。
- **檢索到的原始會議內容永不原樣播出**,只作為 gpt-live 改寫素材。
- 使用者未靜音時提問,遠端自然聽到問題(原音),此模式屬預期。
- barge-in:偵測到使用者開口 → 對問答 session `response.cancel` 並停掉已緩衝播放,人聲永遠優先。
- 問答 session 只收文字輸入(不重聽音訊),其答案經會議回收不會回圈:WakeGate 只聽「me」,且答案播放期間武裝暫停。

## 3. 檢索:FTS5 分層索引(零新依賴,已實測)

Electron 44 內建 Node v24.18.1,`node:sqlite` + FTS5 免 flag:

```sql
CREATE VIRTUAL TABLE meeting_idx USING fts5(
  session_id, tier, heading, body,  -- tier = summary | transcript
  tokenize = 'trigram'              -- 中英通吃
);
-- metadata 另建普通 table: session_id, started_at, title
```

- **兩層語料同表、tier 加權**:`summary` 層(每場的 Decisions/Actions/結論 sections)小而高訊號,「X 的結論是什麼」先命中;`transcript` 層供「當時具體怎麼說」鑽取。
- **索引時機 = RecordsStore finalize**:TransLive 是唯一寫入者,會議結束順手建索引,免 `fs.watch`。
- **實測坑:** trigram 查詢至少 3 字元,中文兩字詞(如「延後」)會 miss → <3 字詞改走 `LIKE` 兜底(語料 MB 級,毫秒)。
- 回傳 bm25 top-6 chunks,帶 `session_id + offset` 作 citation。
- **升級路徑(現在不建):** 同義詞/改寫召回不足時,加本地 embedding 做 hybrid。

## 4. 問答 session 工具契約(2 個唯讀)

| 工具 | 行為 |
| --- | --- |
| `search_past_meetings(query, date_range?, title?)` | metadata filter + FTS 分層 + bm25,回 ≤6 chunks |
| `search_current_meeting(query \| last_n_minutes)` | 讀本場 transcript journal,支援「總結剛才五分鐘」 |

**不需要 agent 框架。** 喚醒→檢索→回答是 1–2 次工具呼叫的單輪問答;gpt-live function calling 已足夠。工具無 write/shell/network;會議內容與檢索結果一律視為 untrusted data,永不當指令(沿用 summary-service 的 prompt-injection 隔離)。

## 5. 回答送出策略(已定案:先審後發)

1. 喚醒觸發 → 問答 session 生成答案,**音訊緩衝在本機,不播**。
2. 本機面板顯示答案文字 + 引用來源。
3. 使用者按「送出」→ 緩衝音訊播入 mixer 進會議;按「拒絕」→ 丟棄,不留音訊。
4. armed 全自動直送為明示選項,預設關。
5. AI-voice 揭露:首次啟用與每場開始前提示「AI 合成語音可能發言」(OpenAI TTS guide 要求)。
6. 所有答案(含未送出)落 meeting record 的 `assistant-answer` audit entry。

## 6. 明確不做

| 項 | 原因 |
| --- | --- |
| Obsidian / MCP / Local REST API | 需求已改:知識庫 = TransLive 自己的 RecordsStore,不接外部 vault |
| Teams 聊天 bot | 外部 tenant 不可行;引用是本地 session id 對遠端無意義;audit 已由 record 承擔 |
| 操控 Teams 白板 | 無即時寫入 API;媒體 bot 也收不到 whiteboard stream(官方 samples issue [#387](https://github.com/microsoftgraph/microsoft-graph-comms-samples/issues/387)) |
| 向量/embedding 搜尋 | FTS5 分層先上,召回不足再 hybrid(YAGNI) |
| RX 側喚醒(遠端喊 translive) | 等於開放任何人觸發你的會議記錄;預設不做 |
| 多輪 S2S 對話 | 單輪先驗價值 |
| UI automation | 前篇已定:永不當 production |

## 7. 驗收條件

1. 會議中雙路轉錄不中斷,「me/remote」來源標記正確;無翻譯 session 被啟動。
2. 喚醒→面板顯示答案 <6s,含引用;無證據時明說「已記錄的會議中找不到」,不補完。
3. 未按「送出」前會議聽不到任何答案;批准後才播出;拒絕不留音訊。
4. 問過去會議結論(如「上次 Acme 週會決議」)命中 summary 層並給出場次+時間引用;中文兩字詞可查。
5. 回答播放中使用者開口,barge-in 立即停止播放、原音直通不受影響。
6. 助手自己的回答(經會議回收)不觸發新一輪喚醒。
7. 會後 summary 帶引用入 RecordsStore;刪除 session 時索引與產物一併清除。
