# Phase 1 Windows E2E runbook

## Purpose

This runbook verifies the Phase 1 question only: can one authenticated Codex account hold two concurrent GPT‑Live V3 WebRTC sessions with isolated TX/RX audio routes? It is **not** a production deployment guide.

## Prerequisites

1. Windows 10/11 with wired or USB **headphones**. Do not test with physical speakers.
2. Node 24+ and the repository dependencies:

   ```powershell
   npm ci
   npm test
   npm run check
   ```

3. A deliberately pinned, trusted Codex CLI. This PoC currently requires `codex-cli 0.145.0` unless `TRANSLIVE_CODEX_VERSION` is intentionally changed with a matching test run. `TRANSLIVE_CODEX_BIN` may point at a trusted npm-installed Windows `.cmd` shim; Windows launches it through the local command shell, while Linux uses direct execution:

   ```powershell
   codex --version
   codex login status
   npm run probe:codex
   ```

   `probe:codex` checks the pinned version, `codex login status`, app-server initialize, and an ephemeral `thread/start`; it does **not** start GPT‑Live or send audio. Login and version preflight do **not** prove GPT‑Live entitlement: only an explicit **Start dual channel** request can do that.
4. Two separately configured VB-CABLE-style endpoint pairs. Do not redistribute a third-party driver without its license permission.
5. Zoom Desktop and Teams Desktop installed. A second meeting participant or second machine is required to prove the remote path.

## Exact virtual routing

Use two one-way cable pairs. Vendor suffixes may vary, but Phase 1 preflight requires the selected names to contain the recognizable `Cable-A Input` and `Cable-B Output` roles.

| Bus | TransLive selection | Meeting-app selection | Direction |
| --- | --- | --- | --- |
| Cable A | **Cable-A Input** as TX output sink | **Cable-A Output** as Zoom/Teams microphone | translated TX → remote meeting |
| Cable B | **Cable-B Output** as RX input source | **Cable-B Input** as Zoom/Teams speaker | remote meeting → translated RX |

Also select:

- physical microphone as **TX source**;
- physical headphones as **RX output sink**.

Every one of the four selections must be different and have the expected Windows kind: TX/RX sources are `audioinput`; Cable-A/headphone sinks are `audiooutput`. Do not use system loopback or reuse Cable A for Cable B. Device names do not prove an endpoint is headphones; the operator must confirm the actual hardware.

## Start the PoC

```powershell
$env:TRANSLIVE_EVIDENCE_DIR = "$PWD\.translive-evidence"
npm start
```

1. Select Teams or Zoom in the app.
2. Click **Refresh devices** and allow microphone permission.
3. Select the four endpoints shown in the routing table.
4. Confirm the headphone checkbox, then click **Test headphones**. The user-gesture tone must play only through the selected headphone endpoint.
5. Click **Route preflight**. It checks endpoint kinds, uniqueness, pinned Codex version, and login status. It must pass before starting.
6. In Zoom/Teams manually set microphone and speaker exactly as shown above. TransLive intentionally does not alter Windows or meeting-app settings.
7. Click **Start dual channel**. The app starts with each channel in `connecting`; it becomes `live` only after its WebRTC answer is applied. Fixed voices are TX Marin and RX Cove.

A blocked start (missing Codex entitlement, login/version mismatch, permission denial, rejected V3 request, or SDP/output-routing failure) is a valid Phase 1 no-go result. The app writes redacted blocked-attempt evidence; do not substitute another model.

## Test order

### 1. TX-only route test

1. Start a meeting with a remote participant.
2. In TransLive mute RX.
3. Speak short Traditional Chinese sentences into the physical microphone.
4. The remote participant should hear only English from Cable-A microphone, not original Chinese and not a feedback loop.
5. Record observed first translated audio and whether the remote participant heard it.
6. Stop, then save the redacted evidence file location.

### 2. RX-only route test

1. Start another clean run and mute TX.
2. The remote participant speaks English.
3. Confirm the meeting app writes into Cable-B Input and TransLive captures Cable-B Output.
4. Confirm only Traditional Chinese is played through physical headphones.
5. Record first translated audio and verify no Cable-A audio reaches the headphones.
6. Stop and save evidence.

### 3. Full-duplex test

1. Start a clean run with neither channel muted.
2. Both people speak normal short turns, then overlap speech for at least 30 seconds.
3. Verify TX/RX state remains separately observable and no channel cross-routes or creates digital feedback.
4. Test TX mute/unmute and RX mute/unmute independently.
5. Click **Stop** and verify both states become stopped and a redacted evidence JSON appears.

### 4. Sustained test

Run full-duplex for 10 minutes with:

- short sentences;
- 30-second continuous speech in each direction;
- names, dates and numbers;
- overlapping speech;
- a deliberate device-level mute/unmute;
- a clean Stop.

No automatic reconnect is implemented in Phase 1. If a session disconnects, stop, retain evidence, and start a fresh run.

## Phase 1 gates

These are project gates, not OpenAI or meeting-app SLAs:

| Metric | Gate |
| --- | ---: |
| TTFA P50 | ≤ 1.5 s |
| TTFA P95 | ≤ 2.5 s |
| Observed interpretation lag P95 | ≤ 4.0 s |
| Digital feedback / unbounded lag / cross-route | zero tolerated |
| Zoom and Teams end-to-end route | both must pass |

The evidence file records platform/model/voices, pinned and actual Codex versions, executable checksum when resolvable, endpoint display names plus hashed IDs, actual thread/realtime-session IDs, state transitions, transcript timestamps only, TTFA/activity-gap/RTT count+p50+p95 summaries, termination reason, explicit pass/fail/insufficient gate status, and redacted errors. Audio activity cannot be semantically aligned to the corresponding translated phrase, so the artifact deliberately reports interpretation lag as `insufficient`; measure that gate with externally aligned source/translated recordings during the manual run. It never contains transcript text, raw SDP, authorization headers, OAuth/account identifiers, tokens, or audio.

## Validated here vs. still manual

This Linux development environment can run the Node seam tests, the deterministic fake app-server protocol fixture, static checks, and the non-billable Codex initialize/ephemeral-thread probe. It **cannot** validate:

- Windows WASAPI/device enumeration and Electron media permissions;
- `setSinkId` routing to actual VB-CABLE or physical headphones;
- Zoom/Teams device behavior;
- live GPT‑Live entitlement, translation-only behavior, audio quality, cost, latency, or concurrent real sessions;
- a 10-minute physical full-duplex run.

Those checks must be performed interactively on Windows with the above setup. Do not send microphone audio or invoke a GPT‑Live session until the operator explicitly presses Start.
