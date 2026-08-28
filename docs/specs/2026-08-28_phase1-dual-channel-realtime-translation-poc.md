# Phase 1：雙通道 GPT‑Live 即時翻譯 PoC

## Problem Statement

使用者需要先證明：在同一台 Windows 電腦上，Codex 的實驗性 GPT‑Live V3 能否同時維持兩個獨立語音 session，讓本機語音翻譯後送入 Zoom／Teams，也讓 Zoom／Teams 的遠端語音翻譯後送到本機耳機，且延遲、路由隔離與穩定性足以支持後續產品化。

目前最大的未知並不是完整 UI，而是以下核心假設是否成立：

- 測試帳戶具備 `gpt-live-1-codex` entitlement；
- 兩個不同 Codex thread 能同時維持 V3／Frameless Bidi session；
- prompt-only translation 能持續只輸出目標語言，不回答、解釋或加入 filler；
- 兩組虛擬音訊 cable 能隔離 TX／RX，避免數位 feedback；
- Zoom 與 Teams 都能使用這組路由；
- 真實 TTFA 與持續 interpretation lag 在可接受範圍內。

如果這些假設未通過，就不應先投入完整 Beta UI、自有驅動、逐字稿、摘要或 voice clone。

## Solution

建立一個最小 Windows Electron PoC，以已登入的 Codex 環境啟動 `codex app-server`，並建立兩個不同 thread、兩個 WebRTC PeerConnection：

- **TX 通道**：實體麥克風 → GPT‑Live 繁中轉英文 → Virtual Cable A → Zoom／Teams 麥克風；
- **RX 通道**：Zoom／Teams 喇叭 → Virtual Cable B → GPT‑Live 英文轉繁中 → 實體耳機。

PoC 只提供完成實驗所需的裝置選擇、Start／Stop、TX／RX mute、通道狀態、即時字幕與延遲指標。測試者手動在 Zoom／Teams 選擇虛擬裝置。PoC 不提供正式安裝體驗、OAuth UI、歷史紀錄或其他產品功能。

PoC 的成功標準是產出可重現證據，回答「雙通道 GPT‑Live 是否值得進入 Phase 2」，而不是交付可散布產品。

## User Stories

1. As a PoC operator, I want to verify the installed Codex version before starting, so that experimental protocol differences do not invalidate the test.
2. As a PoC operator, I want the app to detect whether Codex is already authenticated, so that missing authentication is distinguished from model or transport failures.
3. As a PoC operator, I want the app to verify GPT‑Live entitlement before opening both channels, so that an unsupported account fails early with useful evidence.
4. As a PoC operator, I want entitlement failure to block the test rather than silently use another model, so that every result genuinely measures GPT‑Live.
5. As a PoC operator, I want to select one physical microphone, so that TX always has an explicit audio source.
6. As a PoC operator, I want to select one physical headphone endpoint, so that RX does not accidentally play through speakers and re-enter the microphone.
7. As a PoC operator, I want the app to detect Virtual Cable A and Virtual Cable B endpoints, so that missing virtual devices are reported before a meeting starts.
8. As a PoC operator, I want the app to reject duplicated or cyclic endpoint assignments, so that a routing error cannot create digital feedback.
9. As a PoC operator, I want a microphone level meter, so that I can confirm the TX input before opening a GPT‑Live session.
10. As a PoC operator, I want a headphone test tone, so that I can confirm the RX output without joining a meeting.
11. As a PoC operator, I want fixed Traditional Chinese-to-English TX instructions, so that Phase 1 tests one translation behavior rather than a generic language system.
12. As a PoC operator, I want fixed English-to-Traditional-Chinese RX instructions, so that the return path can be measured independently.
13. As a PoC operator, I want TX and RX to use different Codex threads, so that starting the second session does not stop the first.
14. As a PoC operator, I want TX and RX to use separate PeerConnections, so that transport state, audio tracks and errors remain attributable to one direction.
15. As a PoC operator, I want the app to start both channels from one action, so that full-duplex startup can be evaluated consistently.
16. As a PoC operator, I want to see each channel move through connecting, live, muted, failed and stopped states, so that failures are not hidden behind one global status.
17. As a local speaker, I want only the English translation routed to the meeting microphone, so that remote participants do not hear overlapping original and translated speech.
18. As a local listener, I want only the Traditional Chinese translation routed to my headphones, so that the remote original does not overlap the translation.
19. As a local speaker, I want to mute TX without stopping RX, so that I can listen without transmitting.
20. As a local listener, I want to mute RX without stopping TX, so that I can temporarily silence translated playback.
21. As a PoC operator, I want one Stop action to terminate both sessions and release all audio tracks, so that the next test starts from a clean state.
22. As a PoC operator, I want source and output transcript events shown separately for TX and RX, so that I can confirm the model is translating rather than answering.
23. As a PoC operator, I want the first input-audio timestamp and first translated-audio timestamp captured per channel, so that TTFA can be measured.
24. As a PoC operator, I want continuous lag samples during long speech, so that fast first audio is not mistaken for consistently low interpretation lag.
25. As a PoC operator, I want WebRTC statistics recorded per channel, so that network loss and jitter can be separated from model delay.
26. As a PoC operator, I want session and request identifiers shown in diagnostics without credentials, so that upstream failures can be correlated safely.
27. As a PoC operator, I want transient transcript text displayed but not permanently saved, so that Phase 1 collects only evidence required for the architecture decision.
28. As a PoC operator, I want timing and error evidence written to one local run artifact, so that Zoom and Teams runs can be compared later.
29. As a PoC operator, I want the artifact to exclude OAuth tokens, account identifiers, raw SDP and audio, so that a diagnostic run does not become a credential or recording leak.
30. As a PoC operator, I want to run the same test with Zoom and Teams by changing only their selected OS endpoints, so that meeting-platform integration is tested without SDK work.
31. As a remote Zoom participant, I want to hear the translated TX audio, so that routing is proven beyond the local virtual endpoint.
32. As a remote Teams participant, I want to hear the translated TX audio, so that Teams device handling is independently proven.
33. As a local Zoom participant, I want to hear translated RX audio from my headphones, so that the complete Zoom return path is proven.
34. As a local Teams participant, I want to hear translated RX audio from my headphones, so that the complete Teams return path is proven.
35. As a PoC operator, I want a ten-minute full-duplex run, so that accumulating latency, resource leaks and feedback are observable.
36. As a PoC operator, I want overlapping TX and RX speech included in the test, so that the two sessions are proven independent under realistic contention.
37. As a PoC operator, I want a failed channel to leave the other channel observable, so that failure isolation can be evaluated even though automatic recovery is deferred.
38. As a product owner, I want an explicit go/no-go result after the PoC, so that Phase 2 is not approved merely because a socket connected.
39. As a product owner, I want unsupported translation behavior, entitlement or latency documented as blockers, so that experimental Codex functionality is not presented as a supported production API.
40. As a future implementer, I want the experiment configuration and acceptance evidence recorded, so that the result can be reproduced against a later Codex release.

## Implementation Decisions

- Phase 1 is a developer PoC, not the封閉 Beta product. It uses an already authenticated Codex environment and does not implement ChatGPT OAuth UI.
- The PoC is an Electron desktop process because browser WebRTC, media-device selection and output sink routing provide the shortest path to testing Codex app-server’s WebRTC contract.
- Codex is pinned to one tested version for the whole experiment. The PoC records the executable version and checksum in every run artifact.
- GPT‑Live is accessed only through `codex app-server` over stdio JSON-RPC. The Electron renderer never reads Codex credentials.
- Realtime experimental capability is explicitly enabled during app-server initialization.
- TX and RX each own a different Codex thread, one PeerConnection, one input MediaStreamTrack, one remote output track and one state record.
- Both sessions use Realtime V3, audio output modality and model `gpt-live-1-codex`.
- TX instructions require continuous Traditional Chinese-to-English simultaneous interpretation, translation-only output, no answers, no explanation, no acknowledgement and no filler.
- RX instructions require continuous English-to-Taiwan Traditional Chinese simultaneous interpretation with the same translation-only restrictions.
- Phase 1 uses fixed, visibly different built-in voices for TX and RX so operators can identify cross-routing. Voice selection UI is deferred.
- The language pair is fixed to Traditional Chinese↔English. Japanese and generic language selection are deferred until the dual-channel architecture passes.
- TX captures one physical microphone and routes the GPT‑Live remote track only to Virtual Cable A’s playback endpoint. Zoom／Teams reads the paired recording endpoint as its microphone.
- Zoom／Teams renders remote audio only to Virtual Cable B’s playback endpoint. RX captures its paired recording endpoint and routes the GPT‑Live remote track only to physical headphones.
- The PoC requires headphones and blocks physical speaker selection.
- Endpoint validation rejects identical input/output endpoint IDs and known TX↔RX cycles before starting either session.
- Zoom and Teams configuration remains manual. The PoC displays the exact expected microphone and speaker names but does not change OS defaults or automate meeting software.
- The PoC has one compact screen: device selectors, route checklist, Start／Stop, independent TX／RX status and mute controls, ephemeral transcripts, and live timing diagnostics.
- Start is atomic from the user’s perspective: both channels begin together. Internally, each channel reports its own result; one failure does not hide the other channel’s state.
- Phase 1 does not implement automatic reconnection. It records disconnect behavior and permits a manual clean restart, avoiding recovery logic before the core path is proven.
- The PoC does not implement a custom audio buffer or stale-audio dropping layer because browser WebRTC owns remote-track scheduling. It measures growing interpretation lag; a custom low-latency audio pipeline is a later decision only if measurements prove it necessary.
- Transcripts are displayed in memory for diagnosis but are not persisted. The only persisted run artifact contains configuration, state transitions, timings, WebRTC statistics and redacted errors.
- No raw or translated audio is recorded.
- No fallback model is available. An unavailable model, rejected session, missing entitlement or unsupported prompt behavior produces a no-go evidence record.
- The PoC must expose the exact test boundary as one orchestration contract: start a dual-channel run with explicit endpoints, observe channel events and metrics, then stop and receive a final evidence summary.
- Phase 1 acceptance targets are intentionally broad: TTFA P50 ≤1.5 seconds, TTFA P95 ≤2.5 seconds and continuous interpretation lag P95 ≤4 seconds. These are project gates, not OpenAI guarantees.
- A passing architecture also requires no digital feedback, no unbounded lag growth, no channel cross-routing and successful end-to-end audio through both Zoom and Teams.

## Testing Decisions

- Tests assert externally visible orchestration behavior, not WebRTC, Electron or Codex internal implementation details.
- The primary automated test seam is the single dual-channel orchestration contract. A test supplies deterministic fake device tracks and a fake app-server transport, then observes channel states, route assignments, transcript events, timing samples, stop behavior and final evidence.
- No separate mock-heavy tests are created for every helper. Pure utility tests are added only if endpoint-cycle validation or metric aggregation contains non-trivial branching that cannot be covered clearly through the orchestration seam.
- The orchestration contract must prove that TX and RX use different thread IDs and transport instances without asserting private class structure.
- The orchestration contract must prove that the TX output route never targets headphones or Cable B and the RX output route never targets Cable A.
- The orchestration contract must prove that one channel failing does not overwrite or misreport the other channel’s state.
- The orchestration contract must prove that Stop releases both channels once and produces a final evidence result even when one channel already failed.
- The orchestration contract must prove that credential-shaped fields and raw SDP are absent from persisted evidence.
- A real-service smoke test is manual and gated by explicit operator intent because it consumes account entitlement and sends audio to OpenAI.
- The real-service smoke test first runs one TX session, then one RX session, then both concurrently. This isolates entitlement, prompt and concurrency failures.
- The first real full-duplex acceptance run uses prerecorded, consented test utterances before live speech, making timing comparisons repeatable.
- Zoom and Teams are each tested end-to-end with a second participant or second machine. Local endpoint meters alone are insufficient evidence.
- Each platform run covers: short utterances, continuous 30-second speech, overlapping TX/RX speech, mute/unmute, clean Stop and a ten-minute sustained session.
- Timing evidence records capture time, session-start time, first output transcript, first output audio, periodic lag samples, WebRTC RTT/jitter/loss and termination reason.
- Phase 1 reports p50 and p95 over a stated sample count; isolated best-case measurements are not accepted.
- Translation quality is evaluated manually for whether the model consistently translates only into the target language and avoids assistant-like responses. A comprehensive linguistic benchmark is deferred.
- A good passing test is reproducible with the pinned Codex version, exact endpoint mapping, network description and the same audio fixtures.
- A no-go result is also valid completion when it includes the failing stage, redacted upstream error, environment, reproduction steps and which assumption was falsified.
- There is no existing application test prior art because the repository currently contains research and design documents only. The new orchestration seam becomes the project’s first behavioral-test convention.

## Out of Scope

- ChatGPT OAuth UI, onboarding wizard and multi-user封閉 Beta distribution;
- bundled installer, updater and code signing;
- Japanese translation or arbitrary language selection;
- runtime voice selection or voice cloning;
- transcript persistence, meeting history and meeting summary;
- mini overlay, global shortcuts and polished accessibility pass;
- automatic reconnect, degraded-mode product UX and stale-audio dropping;
- custom virtual audio driver, driver bundling or driver signing;
- Zoom／Teams SDK, Bot integration, participant identification or per-speaker audio;
- original-audio mixing, speaker mode, AEC and far-field support;
- production token broker or Platform API fallback;
- commercial entitlement, legal approval or production SLA claims;
- cloud storage, telemetry backend, recording or analytics;
- translation-quality benchmark beyond manual translation-only verification.

## Further Notes

- The PoC must be stopped after the architecture questions are answered. Product features belong to later phases and must not be pulled into this work to make the demo look complete.
- `gpt-live-1-codex`, `/v1/live` and realtime app-server methods remain experimental. A successful PoC demonstrates behavior for the tested account and Codex version only.
- Phase 2 may begin only if the final evidence confirms concurrent sessions, correct bidirectional routing, translation-only behavior, acceptable measured latency and successful Zoom／Teams end-to-end runs.
- If GPT‑Live entitlement or prompt-driven translation fails, the result should trigger an architecture decision rather than an undocumented request workaround.
- The supporting research and full Beta design remain authoritative context, but this spec intentionally narrows delivery to the dual-channel translation proof.
