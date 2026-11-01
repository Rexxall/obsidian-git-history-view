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
import { tr } from "../i18n";

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
      ? tr("该版本满足文本断言。", "This version satisfies the text assertion.")
      : tr("该版本不满足文本断言。", "This version does not satisfy the text assertion."),
    evidence
  );
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
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
    return unknownAutomatic("invalid-assertion", tr("属性名不能为空。", "The property name cannot be empty."));
  }
  const frontmatter = inspectFrontmatter(content);
  if (frontmatter.state === "invalid") {
    return unknownAutomatic(
      "invalid-frontmatter",
      tr(`Frontmatter 无法解析：${frontmatter.error}`, `The frontmatter cannot be parsed: ${frontmatter.error}`),
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
        ? tr(`属性“${property}”${present ? "存在" : "缺失"}。`, `Property "${property}" ${present ? "exists" : "is missing"}.`)
        : tr(`属性“${property}”${present ? "仍然存在" : "并不存在"}。`, `Property "${property}" ${present ? "still exists" : "does not exist"}.`),
      evidence
    );
  }

  if (!("expected" in assertion)) {
    return unknownAutomatic(
      "invalid-assertion",
      tr(`属性 ${assertion.operator} 断言缺少期望值。`, `The property ${assertion.operator} assertion has no expected value.`),
      evidence
    );
  }
  if (!present) {
    return automaticResult(
      false,
      tr(`属性“${property}”缺失，不能满足 ${assertion.operator} 断言。`, `Property "${property}" is missing, so the ${assertion.operator} assertion cannot hold.`)
    );
  }

  const caseSensitive = assertion.caseSensitive !== false;
  const holds = assertion.operator === "equals"
    ? typedEqual(value, assertion.expected, caseSensitive)
    : typedContains(value, assertion.expected, caseSensitive);
  return automaticResult(
    holds,
    holds
      ? tr(`属性“${property}”以 ${valueType(value)} 类型满足断言。`, `Property "${property}" satisfies the assertion as a ${valueType(value)}.`)
      : tr(`属性“${property}”的 ${valueType(value)} 类型值不满足断言。`, `Property "${property}" as a ${valueType(value)} does not satisfy the assertion.`),
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
    return unknownAutomatic("invalid-assertion", tr("关系目标不能为空。", "The relation target cannot be empty."));
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
      ? tr(`关系 ${assertion.relation} “${assertion.target}”满足断言。`, `Relation ${assertion.relation} "${assertion.target}" satisfies the assertion.`)
      : tr(`关系 ${assertion.relation} “${assertion.target}”不满足断言。`, `Relation ${assertion.relation} "${assertion.target}" does not satisfy the assertion.`),
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
      ? tr(`${assertion.structure}${namedValue} 满足结构断言。`, `${assertion.structure}${namedValue} satisfies the structure assertion.`)
      : tr(`${assertion.structure}${namedValue} 不满足结构断言。`, `${assertion.structure}${namedValue} does not satisfy the structure assertion.`),
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
          ? tr("检测到未解决的 Git 冲突标记。", "Unresolved Git conflict markers found.")
          : tr("未检测到 Git 冲突标记。", "No Git conflict markers found."),
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
          ? tr(`Frontmatter 无效：${frontmatter.error}`, `The frontmatter is invalid: ${frontmatter.error}`)
          : frontmatter.state === "ready"
            ? tr("Frontmatter 是有效的属性对象。", "The frontmatter is a valid set of properties.")
            : tr("笔记没有 Frontmatter，不存在 YAML 解析错误。", "The note has no frontmatter, so there is no YAML error."),
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
          tr(`无法确定正文边界：${frontmatter.error}`, `Cannot tell where the text starts: ${frontmatter.error}`),
          evidenceFromRange(content, 0, frontmatter.bodyStart)
        );
      }
      const body = frontmatter.body;
      const firstNonWhitespace = body.search(/\S/u);
      const holds = firstNonWhitespace >= 0;
      const offset = frontmatter.bodyStart;
      return automaticResult(
        holds,
        holds ? tr("笔记正文包含非空白内容。", "The note text has non-blank content.") : tr("笔记正文为空。", "The note text is empty."),
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
        tr(`未知的内置规则：${assertion.ruleId}`, `Unknown built-in rule: ${assertion.ruleId}`)
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
      detail: version.manualDetail?.trim() || tr("该版本尚未人工判定。", "Not judged yet."),
      provenance: "manual"
    };
  }
  return {
    outcome,
    reason: outcome === "holds" ? "condition-met" : "condition-not-met",
    detail: version.manualDetail?.trim()
      || (outcome === "holds" ? tr("人工判定：成立。", "Human judgement: holds.") : tr("人工判定：不成立。", "Human judgement: does not hold.")),
    provenance: "manual"
  };
}

export function evaluateKnowledgeAssertion(
  assertion: KnowledgeAssertion,
  version: KnowledgeTraceVersion
): KnowledgeAssertionEvaluation {
  if (typeof version.content !== "string") {
    const detail = version.unavailableReason?.trim()
      || tr("该版本正文不可读，不能推断断言结果。", "This version's text cannot be read, so the assertion cannot be inferred.");
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
