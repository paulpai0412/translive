const HAN_CHARACTERS = /\p{Script=Han}/gu;
const LATIN_WORDS = /\p{Script=Latin}+(?:['’-]\p{Script=Latin}+)*/gu;
const NUMERIC_TOKENS = /\p{Number}+(?:[.,:/-]\p{Number}+)*/gu;
const SEGMENT_METRIC_KEYS = Object.freeze({
  "fast-start": "fastStartSegments",
  coalesced: "coalescedSegments",
  steady: "steadySegments",
});

/**
 * Versioned defaults for natural conversational simultaneous translation.
 * Thresholds live in this policy so calibration changes data, not branches.
 */
export const NATURAL_SYNC_PACING_POLICY = Object.freeze({
  id: "natural-sync",
  version: 1,
  millisecondsPerSecond: 1_000,
  chineseCharactersPerSecond: 4,
  latinWordsPerSecond: 2,
  numericTokensPerSecond: 2,
  minimumAudibleCharacters: 12,
  minimumEstimatedSpeechMs: 250,
  fastStartTargetMs: 1_000,
  steadySegmentTargetMs: 2_000,
  coalescedSegmentTargetMs: 3_000,
  // A hard playout cap prevents one long punctuation-free utterance from
  // becoming a multi-minute scheduled segment. The tolerance lets an
  // otherwise natural nearby boundary win over a mechanical split.
  maxSegmentPlayoutMs: 3_500,
  boundaryToleranceMs: 2_500,
  targetBacklogMs: 2_000,
  backlogEnterMs: 3_500,
  backlogExitMs: 1_500,
  lagWarningEnterMs: 4_500,
  lagWarningExitMs: 2_500,
  maxScheduledBacklogMs: 4_000,
  maxOutstandingSegments: 8,
  tailTranscriptDrainMs: 750,
  drainTimeoutMs: 750,
  echoDedupeMs: 5_000,
  sourceFinalDedupeMs: 1_000,
  maxEchoHistory: 16,
  hardBoundaries: "。！？；.!?;",
  softBoundaries: "，,、：:",
});

function matches(text, pattern) {
  return [...String(text ?? "").matchAll(pattern)];
}

/**
 * Estimate natural playout time from target-language content. This estimate
 * is intentionally aggregate-only in evidence; transcript text never leaves
 * the active controller/renderer path.
 */
export function estimateSpeechDurationMs(
  text,
  policy = NATURAL_SYNC_PACING_POLICY,
) {
  const value = String(text ?? "").trim();
  if (!value) return 0;
  const milliseconds = policy.millisecondsPerSecond;
  const chinese = matches(value, HAN_CHARACTERS).length;
  const latin = matches(value, LATIN_WORDS).length;
  const numeric = matches(value, NUMERIC_TOKENS).length;
  const estimated = Math.round(
    milliseconds *
      (chinese / policy.chineseCharactersPerSecond +
        latin / policy.latinWordsPerSecond +
        numeric / policy.numericTokensPerSecond),
  );
  return Math.max(policy.minimumEstimatedSpeechMs ?? 0, estimated);
}

function textUnits(value) {
  return Array.from(String(value ?? ""));
}

function characterCount(value) {
  return textUnits(value).length;
}

function targetIndex(units, targetDurationMs, policy) {
  let text = "";
  for (const [index, unit] of units.entries()) {
    text += unit;
    if (estimateSpeechDurationMs(text, policy) >= targetDurationMs) {
      return index + 1;
    }
  }
  return undefined;
}

function lastBoundaryIndex(
  units,
  boundaryCharacters,
  minimumCharacters,
  limit,
) {
  let candidate;
  for (let index = 0; index < Math.min(units.length, limit); index += 1) {
    const end = index + 1;
    if (end >= minimumCharacters && boundaryCharacters.includes(units[index])) {
      candidate = end;
    }
  }
  return candidate;
}

function targetDuration({ first, policy, constrained }) {
  if (first) return policy.fastStartTargetMs;
  if (constrained) return policy.coalescedSegmentTargetMs;
  return policy.steadySegmentTargetMs;
}

function segmentKind({ first, constrained }) {
  if (first) return "fast-start";
  if (constrained) return "coalesced";
  return "steady";
}

function waitingReason({ buffer, final, policy, constrained }) {
  if (characterCount(buffer) < policy.minimumAudibleCharacters) {
    return final ? "final-below-minimum" : "below-minimum";
  }
  if (constrained) return "coalescing";
  return "awaiting-boundary";
}

function policySegmentLimit({ desiredDurationMs, policy }) {
  return Math.min(
    policy.maxSegmentPlayoutMs,
    desiredDurationMs + policy.boundaryToleranceMs,
  );
}

function selectSegment(text, { final, first, policy, constrained }) {
  const units = textUnits(text);
  const minimum = policy.minimumAudibleCharacters;
  if (units.length < minimum) return undefined;

  const desiredDurationMs = targetDuration({ first, policy, constrained });
  const desiredIndex = targetIndex(units, desiredDurationMs, policy);
  const boundedTargetIndex = desiredIndex
    ? Math.max(minimum, desiredIndex)
    : undefined;
  const limitDurationMs = policySegmentLimit({ desiredDurationMs, policy });
  const limitIndex = Math.max(
    minimum,
    targetIndex(units, limitDurationMs, policy) ?? units.length,
  );
  const boundedLimit = Math.min(units.length, limitIndex);
  const hardLimitIndex = Math.max(
    minimum,
    targetIndex(units, policy.maxSegmentPlayoutMs, policy) ?? units.length,
  );
  const boundedHardLimit = Math.min(units.length, hardLimitIndex);
  const boundaries = `${policy.hardBoundaries}${policy.softBoundaries}`;
  const semanticBoundary = lastBoundaryIndex(
    units,
    boundaries,
    minimum,
    boundedLimit,
  );

  // Prefer an available semantic boundary only inside the policy cap. Under
  // backlog pressure, wait for a boundary that has reached the longer
  // coalesced target instead of sending another short burst.
  if (
    semanticBoundary &&
    (!constrained ||
      estimateSpeechDurationMs(
        units.slice(0, semanticBoundary).join(""),
        policy,
      ) >= desiredDurationMs)
  ) {
    return units.slice(0, semanticBoundary).join("");
  }

  // A complete final that already fits the hard cap should not be split
  // merely to satisfy an earlier fast-start target and strand a tiny tail.
  if (final && units.length <= boundedHardLimit) return units.join("");
  if (boundedTargetIndex) {
    return units.slice(0, Math.min(boundedTargetIndex, boundedLimit)).join("");
  }
  // A long punctuation-free stream must still be capped. A short non-final
  // stream waits for more context instead of producing a rushed fragment.
  if (units.length > boundedLimit) return units.slice(0, boundedLimit).join("");
  return undefined;
}

function outstandingLimit(policy) {
  const limits = [
    policy.maxOutstandingSegments,
    policy.maxCommittedSegments,
  ].filter((value) => Number.isFinite(value) && value > 0);
  return limits.length > 0 ? Math.min(...limits) : 8;
}

/**
 * Pure pacing state machine. Callers own timers and transport I/O. The
 * controller keeps only un-dispatched segments in its outstanding queue, so
 * the admission cap is rolling rather than a lifetime speech limit.
 */
export class AdaptivePacingController {
  #buffer = "";
  #canceled = false;
  #coalescing = false;
  #firstSegment = true;
  #finalBuffered = false;
  #lagWarning = false;
  #metrics = {
    coalescedSegments: 0,
    dispatchedSegments: 0,
    fastStartSegments: 0,
    lagWarningCount: 0,
    maxBacklogMs: 0,
    scheduledSegments: 0,
    steadySegments: 0,
    waitCount: 0,
  };
  #nextId = 1;
  #outstanding = [];
  #plannedEndMs;
  #policy;

  constructor({ policy = NATURAL_SYNC_PACING_POLICY } = {}) {
    this.#policy = policy;
  }

  ingest({ text, final = false, atMs }) {
    const at = Number(atMs);
    if (!Number.isFinite(at)) throw new Error("Pacing input requires atMs");
    const incoming = String(text ?? "");
    if (!incoming) return final ? this.drain({ atMs: at }) : [];
    this.#buffer += incoming;
    this.#finalBuffered ||= Boolean(final);
    return this.#flushEligible({ atMs: at });
  }

  // Re-evaluate a held backlog without changing whether source text is final.
  refill({ atMs }) {
    const at = Number(atMs);
    if (!Number.isFinite(at)) throw new Error("Pacing refill requires atMs");
    return this.#flushEligible({ atMs: at });
  }

  drain({ atMs }) {
    const at = Number(atMs);
    if (!Number.isFinite(at)) throw new Error("Pacing drain requires atMs");
    this.#finalBuffered = true;
    return this.#flushEligible({ atMs: at });
  }

  pendingHead() {
    const head = this.#outstanding[0];
    return head ? { id: head.id, dispatchAtMs: head.dispatchAtMs } : undefined;
  }

  // A backlog-bound buffer has no dispatchable segment yet, but it becomes
  // eligible when the estimated playout already committed has elapsed.
  nextWakeAtMs({ atMs }) {
    const at = Number(atMs);
    if (!Number.isFinite(at)) throw new Error("Pacing wake requires atMs");
    if (
      this.#canceled ||
      !this.#buffer ||
      this.#outstanding.length > 0 ||
      !Number.isFinite(this.#plannedEndMs) ||
      this.#plannedEndMs <= at
    ) {
      return undefined;
    }
    return this.#plannedEndMs;
  }

  dispatch({ id, atMs }) {
    const at = Number(atMs);
    if (!Number.isFinite(at)) throw new Error("Pacing dispatch requires atMs");
    const head = this.#outstanding[0];
    if (!head || this.#canceled) return { type: "canceled", id };
    if (id !== head.id) {
      return {
        type: "wait",
        id: head.id,
        dispatchAtMs: head.dispatchAtMs,
        reason: "head-of-queue",
      };
    }
    if (at < head.dispatchAtMs) {
      return { type: "wait", id: head.id, dispatchAtMs: head.dispatchAtMs };
    }

    const latenessMs = at - head.dispatchAtMs;
    if (latenessMs > 0) {
      for (const later of this.#outstanding.slice(1)) {
        later.dispatchAtMs += latenessMs;
      }
      this.#plannedEndMs = (this.#plannedEndMs ?? at) + latenessMs;
    }
    this.#outstanding.shift();
    this.#metrics.dispatchedSegments += 1;
    return {
      type: "dispatch",
      id: head.id,
      text: head.text,
      characters: head.characters,
      estimatedDurationMs: head.estimatedDurationMs,
    };
  }

  unsent() {
    const scheduledCharacters = this.#outstanding.reduce(
      (total, segment) => total + segment.characters,
      0,
    );
    return {
      segments: this.#outstanding.length,
      characters: characterCount(this.#buffer) + scheduledCharacters,
    };
  }

  cancel() {
    const unsent = this.unsent();
    this.#canceled = true;
    this.#outstanding = [];
    this.#buffer = "";
    return { type: "canceled", ...unsent };
  }

  metrics({ atMs } = {}) {
    const at = Number.isFinite(atMs) ? atMs : this.#plannedEndMs;
    return {
      policyId: this.#policy.id,
      policyVersion: this.#policy.version,
      backlogMs: this.#backlogAt(at),
      targetBacklogMs: this.#policy.targetBacklogMs,
      maxBacklogMs: this.#metrics.maxBacklogMs,
      scheduledSegments: this.#metrics.scheduledSegments,
      dispatchedSegments: this.#metrics.dispatchedSegments,
      outstandingSegments: this.#outstanding.length,
      fastStartSegments: this.#metrics.fastStartSegments,
      steadySegments: this.#metrics.steadySegments,
      coalescedSegments: this.#metrics.coalescedSegments,
      waitCount: this.#metrics.waitCount,
      lagWarningCount: this.#metrics.lagWarningCount,
    };
  }

  #flushEligible({ atMs }) {
    const decisions = [];
    this.#updateFlow(atMs, decisions);
    while (!this.#canceled && this.#buffer) {
      if (this.#outstanding.length >= outstandingLimit(this.#policy)) {
        this.#wait(decisions, "outstanding-limit");
        break;
      }
      if (
        this.#outstanding.length > 0 &&
        this.#backlogAt(atMs) >= this.#policy.maxScheduledBacklogMs
      ) {
        this.#wait(decisions, "backlog-limit");
        break;
      }

      const segment = selectSegment(this.#buffer, {
        final: this.#finalBuffered,
        first: this.#firstSegment,
        policy: this.#policy,
        constrained: this.#coalescing,
      });
      if (!segment) {
        this.#wait(
          decisions,
          waitingReason({
            buffer: this.#buffer,
            final: this.#finalBuffered,
            policy: this.#policy,
            constrained: this.#coalescing,
          }),
        );
        break;
      }

      const characters = characterCount(segment);
      const dispatchAtMs = Math.max(atMs, this.#plannedEndMs ?? atMs);
      const estimatedDurationMs = estimateSpeechDurationMs(
        segment,
        this.#policy,
      );
      if (
        this.#plannedEndMs > atMs &&
        this.#backlogAt(atMs) + estimatedDurationMs >
          this.#policy.maxScheduledBacklogMs
      ) {
        this.#wait(decisions, "backlog-limit");
        break;
      }
      const kind = segmentKind({
        first: this.#firstSegment,
        constrained: this.#coalescing,
      });
      const scheduled = {
        id: `pacing-${this.#nextId++}`,
        text: segment,
        characters,
        estimatedDurationMs,
        dispatchAtMs,
        kind,
      };
      this.#outstanding.push(scheduled);
      this.#buffer = textUnits(this.#buffer).slice(characters).join("");
      if (!this.#buffer) this.#finalBuffered = false;
      this.#plannedEndMs = dispatchAtMs + estimatedDurationMs;
      this.#firstSegment = false;
      this.#metrics.scheduledSegments += 1;
      this.#metrics[SEGMENT_METRIC_KEYS[kind]] += 1;
      decisions.push({ type: "flush", ...scheduled });
      this.#updateFlow(atMs, decisions);
    }
    return decisions;
  }

  #backlogAt(atMs) {
    return Math.max(0, (this.#plannedEndMs ?? atMs) - atMs);
  }

  #updateFlow(atMs, decisions) {
    const backlogMs = this.#backlogAt(atMs);
    this.#metrics.maxBacklogMs = Math.max(
      this.#metrics.maxBacklogMs,
      backlogMs,
    );
    if (!this.#coalescing && backlogMs >= this.#policy.backlogEnterMs) {
      this.#coalescing = true;
      decisions.push({ type: "coalesce", state: "entered", backlogMs });
    } else if (this.#coalescing && backlogMs <= this.#policy.backlogExitMs) {
      this.#coalescing = false;
      decisions.push({ type: "coalesce", state: "exited", backlogMs });
    }
    if (!this.#lagWarning && backlogMs >= this.#policy.lagWarningEnterMs) {
      this.#lagWarning = true;
      this.#metrics.lagWarningCount += 1;
      decisions.push({ type: "lag-warning", state: "active", backlogMs });
    } else if (this.#lagWarning && backlogMs <= this.#policy.lagWarningExitMs) {
      this.#lagWarning = false;
      decisions.push({ type: "lag-warning", state: "cleared", backlogMs });
    }
  }

  #wait(decisions, reason) {
    this.#metrics.waitCount += 1;
    decisions.push({ type: "wait", reason });
  }
}
