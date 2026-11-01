import { evaluateKnowledgeAssertion } from "./assertion-evaluator";
import type {
  KnowledgeAssertionOutcome,
  KnowledgeBoundary,
  KnowledgeTraceProbe,
  KnowledgeTraceRequest,
  KnowledgeTraceResult,
  KnowledgeVersionEvaluation
} from "./types";
import { tr } from "../i18n";

type KnownOutcome = Exclude<KnowledgeAssertionOutcome, "unknown">;

function isKnownOutcome(outcome: KnowledgeAssertionOutcome): outcome is KnownOutcome {
  return outcome !== "unknown";
}

function boundaryBetween(
  before: KnowledgeVersionEvaluation,
  after: KnowledgeVersionEvaluation
): KnowledgeBoundary | null {
  if (
    !isKnownOutcome(before.outcome)
    || !isKnownOutcome(after.outcome)
    || before.outcome === after.outcome
  ) {
    return null;
  }
  return {
    beforeIndex: before.index,
    afterIndex: after.index,
    beforeVersionKey: before.versionKey,
    afterVersionKey: after.versionKey,
    from: before.outcome,
    to: after.outcome
  };
}

export function traceKnowledgeBoundary(
  request: KnowledgeTraceRequest
): KnowledgeTraceResult {
  const { assertion, versions } = request;
  const verificationMode = assertion.kind === "manual" ? "manual" : "automatic";
  const cache = new Map<number, KnowledgeVersionEvaluation>();
  const probeOrder: KnowledgeTraceProbe[] = [];

  const probe = (
    index: number,
    phase: KnowledgeTraceProbe["phase"]
  ): KnowledgeVersionEvaluation => {
    const version = versions[index];
    if (!version) {
      throw new RangeError(`Knowledge trace version index ${index} is out of range.`);
    }
    const cached = cache.get(index);
    const evaluation = cached ?? {
      ...evaluateKnowledgeAssertion(assertion, version),
      index,
      versionKey: version.key
    };
    if (!cached) cache.set(index, evaluation);
    probeOrder.push({
      phase,
      index,
      versionKey: version.key,
      outcome: evaluation.outcome,
      cached: Boolean(cached)
    });
    return evaluation;
  };

  let candidate: KnowledgeBoundary | null = null;
  if (versions.length === 1) {
    probe(0, "binary");
  } else if (versions.length > 1) {
    let lowerIndex = 0;
    let upperIndex = versions.length - 1;
    let lower = probe(lowerIndex, "binary");
    let upper = probe(upperIndex, "binary");

    if (
      isKnownOutcome(lower.outcome)
      && isKnownOutcome(upper.outcome)
      && lower.outcome !== upper.outcome
    ) {
      while (upperIndex - lowerIndex > 1) {
        const middleIndex = Math.floor((lowerIndex + upperIndex) / 2);
        const middle = probe(middleIndex, "binary");
        if (!isKnownOutcome(middle.outcome)) break;
        if (middle.outcome === lower.outcome) {
          lowerIndex = middleIndex;
          lower = middle;
        } else {
          upperIndex = middleIndex;
          upper = middle;
        }
      }
      if (upperIndex - lowerIndex === 1) {
        candidate = boundaryBetween(lower, upper);
      }
    }
  }

  const evaluations = versions.map((_version, index) =>
    probe(index, "verification")
  );
  const unknownIndices = evaluations
    .filter((evaluation) => evaluation.outcome === "unknown")
    .map((evaluation) => evaluation.index);
  const transitions: KnowledgeBoundary[] = [];
  for (let index = 1; index < evaluations.length; index += 1) {
    const before = evaluations[index - 1];
    const after = evaluations[index];
    if (!before || !after) continue;
    const transition = boundaryBetween(before, after);
    if (transition) transitions.push(transition);
  }

  if (evaluations.length === 0) {
    return {
      conclusion: "empty",
      confirmed: false,
      summary: tr("没有可追踪的版本。", "No versions to trace."),
      candidate,
      boundary: null,
      transitions,
      evaluations,
      unknownIndices,
      probeOrder,
      verificationMode
    };
  }

  if (unknownIndices.length === evaluations.length) {
    return {
      conclusion: "all-unknown",
      confirmed: false,
      summary: tr("所有版本都不可判定，尚不能定位变化边界。", "No version can be decided, so the boundary cannot be found yet."),
      candidate,
      boundary: null,
      transitions,
      evaluations,
      unknownIndices,
      probeOrder,
      verificationMode
    };
  }

  if (unknownIndices.length > 0) {
    return {
      conclusion: "unknown-gap",
      confirmed: false,
      summary: tr("版本序列存在未知间隙，不能跨越间隙推断首次变化。", "There is an unknown gap in the versions, so the first change cannot be inferred across it."),
      candidate,
      boundary: null,
      transitions,
      evaluations,
      unknownIndices,
      probeOrder,
      verificationMode
    };
  }

  if (transitions.length > 1) {
    return {
      conclusion: "repeated-change",
      confirmed: false,
      summary: tr(`断言状态发生了 ${transitions.length} 次变化，不能压缩为单一首次边界。`, `The assertion changed ${transitions.length} times, so it cannot be reduced to one first boundary.`),
      candidate,
      boundary: null,
      transitions,
      evaluations,
      unknownIndices,
      probeOrder,
      verificationMode
    };
  }

  const onlyTransition = transitions[0];
  if (onlyTransition) {
    if (verificationMode === "manual") {
      return {
        conclusion: "manual-candidate",
        confirmed: false,
        summary: tr("人工逐版判定得到唯一相邻转变；这是人工候选，不是自动确认。", "Judging each version by hand gives one change between neighbours; this is a human candidate, not an automatic confirmation."),
        candidate,
        boundary: null,
        transitions,
        evaluations,
        unknownIndices,
        probeOrder,
        verificationMode
      };
    }
    return {
      conclusion: "confirmed",
      confirmed: true,
      summary: tr("完整区间逐版自动验证后，已确认唯一的相邻变化边界。", "Every version in the range was checked automatically and one change between neighbours is confirmed."),
      candidate,
      boundary: onlyTransition,
      transitions,
      evaluations,
      unknownIndices,
      probeOrder,
      verificationMode
    };
  }

  const stableOutcome = evaluations[0]?.outcome;
  if (!stableOutcome || !isKnownOutcome(stableOutcome)) {
    throw new Error("Knowledge trace invariant failed: stable sequence has no known outcome.");
  }
  return {
    conclusion: "stable",
    confirmed: false,
    summary: stableOutcome === "holds"
      ? tr("所有可读版本都满足断言，历史保持成立。", "Every readable version satisfies the assertion; it has always held.")
      : tr("所有可读版本都不满足断言，历史保持不成立。", "No readable version satisfies the assertion; it has never held."),
    candidate,
    boundary: null,
    transitions,
    evaluations,
    unknownIndices,
    probeOrder,
    verificationMode,
    stableOutcome
  };
}
