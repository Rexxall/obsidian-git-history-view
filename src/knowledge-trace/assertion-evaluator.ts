import { extractNoteRelations } from "../analysis/link-impact";
import {
  evidenceFromRange,
  firstTextEvidence,
  inspectFrontmatter,
  maskMarkdownRelationLiterals
} from "./markdown-source";
import { extractMarkdownStructures } from "./markdown-structure";
import type {
  KnowledgeAssertion,
  KnowledgeAssertionEvaluation,
  KnowledgeAssertionEvidence,
  KnowledgeTraceVersion,
  PropertyKnowledgeAssertion,
  RelationKnowledgeAssertion,
  RuleKnowledgeAssertion,
  StructureKnowledgeAssertion,
  TextKnowledgeAssertion
} from "./types";

function normalizeText(
  value: string,
  options: {
    caseSensitive?: boolean;
    normalizeLineEndings?: boolean;
  }
): string {
  let normalized = options.normalizeLineEndings
    ? value.replace(/\r\n?/gu, "\n")
    : value;
  if (options.caseSensitive === false) {
    normalized = normalized.toLocaleLowerCase();
  }
  return normalized;
}

function automaticResult(
  holds: boolean,
  detail: string,
  evidence?: KnowledgeAssertionEvidence
): KnowledgeAssertionEvaluation {
  const result: KnowledgeAssertionEvaluation = {
    outcome: holds ? "holds" : "does-not-hold",
    reason: holds ? "condition-met" : "condition-not-met",
    detail,
    provenance: "automatic"
  };
  if (evidence) result.evidence = evidence;
  return result;
}

function unknownAutomatic(
  reason: Extract<
    KnowledgeAssertionEvaluation["reason"],
    | "content-unavailable"
    | "invalid-frontmatter"
    | "invalid-assertion"
    | "unsupported-assertion"
  >,
  detail: string,
  evidence?: KnowledgeAssertionEvidence
): KnowledgeAssertionEvaluation {
  const result: KnowledgeAssertionEvaluation = {
    outcome: "unknown",
    reason,
    detail,
    provenance: "automatic"
  };
  if (evidence) result.evidence = evidence;
  return result;
}

function evaluateTextAssertion(
  assertion: TextKnowledgeAssertion,
  content: string
): KnowledgeAssertionEvaluation {
  const comparableContent = normalizeText(content, assertion);
  const comparableExpected = normalizeText(assertion.expected, assertion);
  const matchIndex = comparableContent.indexOf(comparableExpected);
  const containsExpected = matchIndex >= 0;

  let holds: boolean;
  switch (assertion.operator) {
    case "contains":
      holds = containsExpected;
      break;
    case "not-contains":
      holds = !containsExpected;
      break;
    case "equals":
      holds = comparableContent === comparableExpected;
      break;
  }

  const evidence = containsExpected && assertion.expected.length > 0
    ? firstTextEvidence(
        content,
        assertion.expected,
        assertion.caseSensitive !== false
      )
    : undefined;
  return automaticResult(
    holds,
    holds
      ? "该版本满足文本断言。"
      : "该版本不满足文本断言。",
    evidence
  );
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOwn(
  value: Readonly<Record<string, unknown>>,
  key: string
): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function typedEqual(
  left: unknown,
  right: unknown,
  caseSensitive: boolean
): boolean {
  if (typeof left === "string" && typeof right === "string") {
    return caseSensitive
      ? left === right
      : left.toLocaleLowerCase() === right.toLocaleLowerCase();
  }
  if (Object.is(left, right)) return true;
  if (typeof left !== typeof right) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    return left.length === right.length
      && left.every((value, index) =>
        typedEqual(value, right[index], caseSensitive)
      );
  }
  if (isRecord(left) || isRecord(right)) {
    if (!isRecord(left) || !isRecord(right)) return false;
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return leftKeys.length === rightKeys.length
      && leftKeys.every((key, index) =>
        key === rightKeys[index]
        && typedEqual(left[key], right[key], caseSensitive)
      );
  }
  return false;
}

function typedContains(
  container: unknown,
  expected: unknown,
  caseSensitive: boolean
): boolean {
  if (typeof container === "string" && typeof expected === "string") {
    const comparableContainer = caseSensitive
      ? container
      : container.toLocaleLowerCase();
    const comparableExpected = caseSensitive
      ? expected
      : expected.toLocaleLowerCase();
    return comparableContainer.includes(comparableExpected);
  }
  if (Array.isArray(container)) {
    const expectedValues = Array.isArray(expected) ? expected : [expected];
    return expectedValues.every((expectedValue) =>
      container.some((value) => typedEqual(value, expectedValue, caseSensitive))
    );
  }
  if (isRecord(container) && isRecord(expected)) {
    return Object.entries(expected).every(([key, value]) =>
      hasOwn(container, key)
      && typedEqual(container[key], value, caseSensitive)
    );
  }
  return false;
}

function valueType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "list";
  if (isRecord(value)) return "object";
  return typeof value;
}

function propertyEvidence(
  content: string,
  bodyStart: number,
  property?: string
): KnowledgeAssertionEvidence {
  if (property) {
    const frontmatter = content.slice(0, bodyStart);
    for (const match of frontmatter.matchAll(/^([^#\s][^:]*):.*$/gmu)) {
      if ((match[1] ?? "").trim() !== property) continue;
      const start = match.index;
      return evidenceFromRange(
        content,
        start,
        start + match[0].length
      );
    }
  }
  return evidenceFromRange(content, 0, bodyStart);
}

function evaluatePropertyAssertion(
  assertion: PropertyKnowledgeAssertion,
  content: string
): KnowledgeAssertionEvaluation {
  const property = assertion.property.trim();
  if (!property) {
    return unknownAutomatic("invalid-assertion", "属性名不能为空。");
  }
  const frontmatter = inspectFrontmatter(content);
  if (frontmatter.state === "invalid") {
    return unknownAutomatic(
      "invalid-frontmatter",
      `Frontmatter 无法解析：${frontmatter.error}`,
      propertyEvidence(content, frontmatter.bodyStart)
    );
  }

  const properties = frontmatter.state === "ready"
    ? frontmatter.properties
    : {};
  const present = hasOwn(properties, property);
  const value = properties[property];
  const evidence = present && frontmatter.state === "ready"
    ? propertyEvidence(content, frontmatter.bodyStart, property)
    : undefined;

  if (assertion.operator === "exists" || assertion.operator === "missing") {
    const holds = assertion.operator === "exists" ? present : !present;
    return automaticResult(
      holds,
      holds
        ? `属性“${property}”${present ? "存在" : "缺失"}。`
        : `属性“${property}”${present ? "仍然存在" : "并不存在"}。`,
      evidence
    );
  }

  if (!("expected" in assertion)) {
    return unknownAutomatic(
      "invalid-assertion",
      `属性 ${assertion.operator} 断言缺少期望值。`,
      evidence
    );
  }
  if (!present) {
    return automaticResult(
      false,
      `属性“${property}”缺失，不能满足 ${assertion.operator} 断言。`
    );
  }

  const caseSensitive = assertion.caseSensitive !== false;
  const holds = assertion.operator === "equals"
    ? typedEqual(value, assertion.expected, caseSensitive)
    : typedContains(value, assertion.expected, caseSensitive);
  return automaticResult(
    holds,
    holds
      ? `属性“${property}”以 ${valueType(value)} 类型满足断言。`
      : `属性“${property}”的 ${valueType(value)} 类型值不满足断言。`,
    evidence
  );
}

function normalizeRelationTarget(
  assertion: RelationKnowledgeAssertion
): string {
  let target = assertion.target.trim();
  try {
    target = decodeURIComponent(target);
  } catch {
    // Keep malformed historical targets comparable as literal text.
  }
  if (assertion.relation === "tag") {
    return target.replace(/^#+/u, "").replace(/\/$/u, "").toLocaleLowerCase();
  }
  return target
    .replace(/^<|>$/gu, "")
    .split("|")[0]!
    .split("#")[0]!
    .trim()
    .toLocaleLowerCase();
}

function evaluateRelationAssertion(
  assertion: RelationKnowledgeAssertion,
  content: string
): KnowledgeAssertionEvaluation {
  const target = normalizeRelationTarget(assertion);
  if (!target) {
    return unknownAutomatic("invalid-assertion", "关系目标不能为空。");
  }
  const comparableContent = maskMarkdownRelationLiterals(content);
  const expectedKind = assertion.relation === "markdown-link"
    ? "markdown"
    : assertion.relation;
  const relation = extractNoteRelations(comparableContent).find((item) =>
    (
      item.kind === expectedKind
      || (expectedKind === "embed" && item.kind === "attachment")
    )
    && item.target.toLocaleLowerCase() === target
  );
  const exists = Boolean(relation);
  const holds = assertion.operator === "exists" ? exists : !exists;
  const query = assertion.relation === "tag" ? `#${target}` : relation?.target ?? target;
  const evidenceIndex = comparableContent
    .toLocaleLowerCase()
    .indexOf(query.toLocaleLowerCase());
  return automaticResult(
    holds,
    holds
      ? `关系 ${assertion.relation} “${assertion.target}”满足断言。`
      : `关系 ${assertion.relation} “${assertion.target}”不满足断言。`,
    exists && evidenceIndex >= 0
      ? evidenceFromRange(
          content,
          evidenceIndex,
          evidenceIndex + query.length
        )
      : undefined
  );
}

function structureValue(
  assertion: StructureKnowledgeAssertion
): string | undefined {
  if (assertion.value === undefined) return undefined;
  const value = assertion.value.trim();
  return assertion.structure === "callout"
    ? value.toLocaleLowerCase()
    : value;
}

function evaluateStructureAssertion(
  assertion: StructureKnowledgeAssertion,
  content: string
): KnowledgeAssertionEvaluation {
  const expectedValue = structureValue(assertion);
  const match = extractMarkdownStructures(content).find((item) =>
    item.structure === assertion.structure
    && (expectedValue === undefined || item.value === expectedValue)
  );
  const exists = Boolean(match);
  const holds = assertion.operator === "exists" ? exists : !exists;
  const namedValue = assertion.value === undefined ? "" : ` “${assertion.value}”`;
  return automaticResult(
    holds,
    holds
      ? `${assertion.structure}${namedValue} 满足结构断言。`
      : `${assertion.structure}${namedValue} 不满足结构断言。`,
    match?.evidence
  );
}

function evaluateRuleAssertion(
  assertion: RuleKnowledgeAssertion,
  content: string
): KnowledgeAssertionEvaluation {
  switch (assertion.ruleId) {
    case "no-conflict-markers": {
      const marker = /^(?:<{7}(?: .*)?|>{7}(?: .*)?)\r?$/gmu.exec(content);
      return automaticResult(
        !marker,
        marker
          ? "检测到未解决的 Git 冲突标记。"
          : "未检测到 Git 冲突标记。",
        marker
          ? evidenceFromRange(
              content,
              marker.index,
              marker.index + marker[0].length
            )
          : undefined
      );
    }
    case "valid-frontmatter": {
      const frontmatter = inspectFrontmatter(content);
      return automaticResult(
        frontmatter.state !== "invalid",
        frontmatter.state === "invalid"
          ? `Frontmatter 无效：${frontmatter.error}`
          : frontmatter.state === "ready"
            ? "Frontmatter 是有效的属性对象。"
            : "笔记没有 Frontmatter，不存在 YAML 解析错误。",
        frontmatter.state === "invalid"
          ? evidenceFromRange(content, 0, frontmatter.bodyStart)
          : undefined
      );
    }
    case "nonempty-body": {
      const frontmatter = inspectFrontmatter(content);
      if (frontmatter.state === "invalid") {
        return unknownAutomatic(
          "invalid-frontmatter",
          `无法确定正文边界：${frontmatter.error}`,
          evidenceFromRange(content, 0, frontmatter.bodyStart)
        );
      }
      const body = frontmatter.body;
      const firstNonWhitespace = body.search(/\S/u);
      const holds = firstNonWhitespace >= 0;
      const offset = frontmatter.bodyStart;
      return automaticResult(
        holds,
        holds ? "笔记正文包含非空白内容。" : "笔记正文为空。",
        holds
          ? evidenceFromRange(
              content,
              offset + firstNonWhitespace,
              offset + firstNonWhitespace + 1
            )
          : undefined
      );
    }
    default:
      return unknownAutomatic(
        "unsupported-assertion",
        `未知的内置规则：${assertion.ruleId}`
      );
  }
}

function evaluateManualAssertion(
  version: KnowledgeTraceVersion
): KnowledgeAssertionEvaluation {
  const outcome = version.manualOutcome;
  if (!outcome || outcome === "unknown") {
    return {
      outcome: "unknown",
      reason: "manual-unjudged",
      detail: version.manualDetail?.trim() || "该版本尚未人工判定。",
      provenance: "manual"
    };
  }
  return {
    outcome,
    reason: outcome === "holds" ? "condition-met" : "condition-not-met",
    detail: version.manualDetail?.trim()
      || (outcome === "holds" ? "人工判定：成立。" : "人工判定：不成立。"),
    provenance: "manual"
  };
}

export function evaluateKnowledgeAssertion(
  assertion: KnowledgeAssertion,
  version: KnowledgeTraceVersion
): KnowledgeAssertionEvaluation {
  if (typeof version.content !== "string") {
    const detail = version.unavailableReason?.trim()
      || "该版本正文不可读，不能推断断言结果。";
    return assertion.kind === "manual"
      ? {
          outcome: "unknown",
          reason: "content-unavailable",
          detail,
          provenance: "manual"
        }
      : unknownAutomatic("content-unavailable", detail);
  }
  if (assertion.kind === "manual") {
    return evaluateManualAssertion(version);
  }

  switch (assertion.kind) {
    case "text":
      return evaluateTextAssertion(assertion, version.content);
    case "property":
      return evaluatePropertyAssertion(assertion, version.content);
    case "relation":
      return evaluateRelationAssertion(assertion, version.content);
    case "structure":
      return evaluateStructureAssertion(assertion, version.content);
    case "rule":
      return evaluateRuleAssertion(assertion, version.content);
  }
}
