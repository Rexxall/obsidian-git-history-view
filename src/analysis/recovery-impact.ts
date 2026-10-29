import {
  buildLinkImpact,
  extractNoteRelations,
  isVaultTargetRelation,
  type NoteRelation
} from "./link-impact";
import { tr } from "../i18n";

export interface IncomingKnowledgeReference {
  sourcePath: string;
  sourceLabel: string;
  kind: "link" | "embed";
  subpath?: string;
  viaAlias?: string;
}

export interface RecoveryImpactFinding {
  id: string;
  severity: "info" | "warning" | "danger";
  kind:
    | "missing-target"
    | "missing-attachment"
    | "broken-inbound-anchor"
    | "broken-alias"
    | "removed-relation";
  title: string;
  detail: string;
  sourcePath?: string;
  relation?: NoteRelation;
}

export interface RecoveryImpactWave {
  severity: "safe" | "review" | "danger";
  summary: string;
  restoredRelations: NoteRelation[];
  removedRelations: NoteRelation[];
  missingTargets: NoteRelation[];
  missingAttachments: NoteRelation[];
  incomingReferences: IncomingKnowledgeReference[];
  brokenIncomingReferences: IncomingKnowledgeReference[];
  findings: RecoveryImpactFinding[];
  currentAnchors: string[];
  targetAnchors: string[];
  currentAliases: string[];
  targetAliases: string[];
}

function normalizeAnchor(value: string): string {
  return value
    .trim()
    .replace(/^#+/u, "")
    .replace(/^\^/u, "")
    .trim()
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s+/gu, " ");
}

export function extractFrontmatterAliases(content: string): string[] {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u);
  if (!match) return [];
  const lines = (match[1] ?? "").split(/\r?\n/u);
  const aliases: string[] = [];
  let collecting = false;
  for (const line of lines) {
    const inline = line.match(/^(?:aliases?|alias)\s*:\s*(.*)$/iu);
    if (inline) {
      collecting = true;
      const value = (inline[1] ?? "").trim();
      if (value.startsWith("[") && value.endsWith("]")) {
        aliases.push(
          ...value
            .slice(1, -1)
            .split(",")
            .map((item) => item.trim().replace(/^["']|["']$/gu, ""))
            .filter(Boolean)
        );
      } else if (value) {
        aliases.push(value.replace(/^["']|["']$/gu, ""));
        collecting = false;
      }
      continue;
    }
    if (collecting) {
      const item = line.match(/^\s*-\s+(.+)$/u)?.[1]?.trim();
      if (item) {
        aliases.push(item.replace(/^["']|["']$/gu, ""));
        continue;
      }
      if (line.trim() && !/^\s/u.test(line)) collecting = false;
    }
  }
  return [...new Set(aliases.filter(Boolean))];
}

export function extractKnowledgeAnchors(content: string): string[] {
  const anchors = new Set<string>();
  for (const line of content.split(/\r?\n/u)) {
    const heading = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/u)?.[1];
    if (heading) anchors.add(normalizeAnchor(heading));
    for (const block of line.matchAll(/(?:^|\s)\^([\p{L}\p{N}_-]+)(?=\s*$)/gu)) {
      if (block[1]) anchors.add(normalizeAnchor(block[1]));
    }
  }
  return [...anchors].filter(Boolean);
}

function incomingReferenceSurvives(
  reference: IncomingKnowledgeReference,
  targetAnchors: Set<string>,
  targetAliases: Set<string>
): boolean {
  if (
    reference.viaAlias
    && !targetAliases.has(reference.viaAlias.toLocaleLowerCase())
  ) return false;
  if (!reference.subpath) return true;
  return targetAnchors.has(normalizeAnchor(reference.subpath));
}

export function buildRecoveryImpactWave(
  currentContent: string,
  targetContent: string,
  options: {
    incomingReferences?: IncomingKnowledgeReference[];
    resolvesTarget?: (relation: NoteRelation) => boolean;
  } = {}
): RecoveryImpactWave {
  const impact = buildLinkImpact(currentContent, targetContent);
  const incomingReferences = options.incomingReferences ?? [];
  const resolvesTarget = options.resolvesTarget ?? (() => true);
  const currentAnchors = extractKnowledgeAnchors(currentContent);
  const targetAnchors = extractKnowledgeAnchors(targetContent);
  const currentAliases = extractFrontmatterAliases(currentContent);
  const targetAliases = extractFrontmatterAliases(targetContent);
  const targetAnchorSet = new Set(targetAnchors);
  const targetAliasSet = new Set(
    targetAliases.map((alias) => alias.toLocaleLowerCase())
  );
  const brokenIncomingReferences = incomingReferences.filter(
    (reference) =>
      !incomingReferenceSurvives(reference, targetAnchorSet, targetAliasSet)
  );
  const targetRelations = extractNoteRelations(targetContent);
  const missingTargets = targetRelations.filter(
    (relation) => isVaultTargetRelation(relation) && !resolvesTarget(relation)
  );
  const missingAttachments = missingTargets.filter(
    (relation) => relation.kind === "attachment"
  );
  const restoredRelations = impact.added.filter(
    (relation) => !isVaultTargetRelation(relation) || resolvesTarget(relation)
  );
  const findings: RecoveryImpactFinding[] = [];

  for (const relation of missingTargets.slice(0, 20)) {
    const attachment = relation.kind === "attachment";
    findings.push({
      id: `missing:${relation.key}`,
      severity: attachment ? "danger" : "warning",
      kind: attachment ? "missing-attachment" : "missing-target",
      title: attachment ? tr("附件已不存在", "Attachment no longer exists") : tr("恢复后仍是断链", "Still a broken link after restoring"),
      detail: `${relation.label}${relation.subpath ?? ""}`,
      relation
    });
  }
  for (const reference of brokenIncomingReferences.slice(0, 20)) {
    const alias = Boolean(reference.viaAlias);
    findings.push({
      id: `incoming:${reference.sourcePath}:${reference.kind}:${reference.subpath ?? reference.viaAlias ?? ""}`,
      severity: "danger",
      kind: alias ? "broken-alias" : "broken-inbound-anchor",
      title: alias ? tr("恢复会移除被引用的别名", "Restoring removes an alias other notes use") : tr("恢复会移除被引用的锚点", "Restoring removes an anchor other notes use"),
      detail: `${reference.sourceLabel} · ${reference.kind === "embed" ? tr("嵌入", "embed") : tr("链接", "link")}${reference.subpath ? ` ${reference.subpath}` : ""}${reference.viaAlias ? ` ${reference.viaAlias}` : ""}`,
      sourcePath: reference.sourcePath
    });
  }
  for (const relation of impact.removed.slice(0, 12)) {
    findings.push({
      id: `removed:${relation.key}`,
      severity: "info",
      kind: "removed-relation",
      title: tr("当前关系会消失", "A current link will disappear"),
      detail: `${relation.label}${relation.subpath ?? ""}`,
      relation
    });
  }

  const severity = brokenIncomingReferences.length > 0
    || missingAttachments.length > 0
    ? "danger"
    : missingTargets.length > 0 || impact.removed.length > 0
      ? "review"
      : "safe";
  const summary = severity === "danger"
    ? tr(`${brokenIncomingReferences.length} 条入站引用可能断裂，${missingAttachments.length} 个附件不存在`, `${brokenIncomingReferences.length} incoming links may break, ${missingAttachments.length} attachments are missing`)
    : severity === "review"
      ? tr(`${restoredRelations.length} 个旧关系将恢复，${missingTargets.length} 个目标无法解析`, `${restoredRelations.length} old links come back, ${missingTargets.length} targets cannot be resolved`)
      : tr(`恢复 ${restoredRelations.length} 个旧关系，未发现新的知识网络风险`, `${restoredRelations.length} old links come back; no new link risks found`);

  return {
    severity,
    summary,
    restoredRelations,
    removedRelations: impact.removed,
    missingTargets,
    missingAttachments,
    incomingReferences,
    brokenIncomingReferences,
    findings,
    currentAnchors,
    targetAnchors,
    currentAliases,
    targetAliases
  };
}
