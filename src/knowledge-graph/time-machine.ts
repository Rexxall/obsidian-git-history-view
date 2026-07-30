import {
  buildLinkImpact,
  extractNoteRelations,
  type NoteRelation,
  type NoteRelationKind
} from "../analysis/link-impact";
import type { VersionReference } from "../models";

export const GRAPH_TIME_MACHINE_MAX_VERSIONS = 80;
export const GRAPH_TIME_MACHINE_MAX_RELATIONS_PER_VERSION = 500;
export const GRAPH_TIME_MACHINE_MAX_CONTENT_BYTES = 2 * 1024 * 1024;

export interface KnowledgeGraphVersion {
  id: string;
  label: string;
  capturedAt: string;
  reference: VersionReference;
  content?: string;
  availability: "ready" | "too-large" | "unavailable";
  warning?: string;
}

export interface KnowledgeGraphTransition {
  id: string;
  from: KnowledgeGraphVersion;
  to: KnowledgeGraphVersion;
  added: NoteRelation[];
  removed: NoteRelation[];
  unchangedCount: number;
  changedKinds: NoteRelationKind[];
  status: "changed" | "stable" | "gap";
  warning?: string;
}

export interface KnowledgeGraphTimeline {
  versions: KnowledgeGraphVersion[];
  transitions: KnowledgeGraphTransition[];
  changedTransitions: KnowledgeGraphTransition[];
  truncated: boolean;
  warnings: string[];
}

function uniqueKinds(relations: NoteRelation[]): NoteRelationKind[] {
  return [...new Set(relations.map((relation) => relation.kind))];
}

function sanitizeVersion(version: KnowledgeGraphVersion): KnowledgeGraphVersion {
  if (version.availability !== "ready" || version.content === undefined) return version;
  const size = new TextEncoder().encode(version.content).byteLength;
  if (size > GRAPH_TIME_MACHINE_MAX_CONTENT_BYTES) {
    const { content: _content, ...metadata } = version;
    return {
      ...metadata,
      availability: "too-large",
      warning: `版本内容为 ${Math.ceil(size / 1024)} KB，超过 2 MB 关系分析上限。`
    };
  }
  const relationCount = extractNoteRelations(version.content).length;
  if (relationCount > GRAPH_TIME_MACHINE_MAX_RELATIONS_PER_VERSION) {
    const { content: _content, ...metadata } = version;
    return {
      ...metadata,
      availability: "too-large",
      warning: `版本包含 ${relationCount} 个关系，超过单版 500 个关系上限。`
    };
  }
  return version;
}

export function buildKnowledgeGraphTimeline(
  inputVersions: KnowledgeGraphVersion[]
): KnowledgeGraphTimeline {
  const truncated = inputVersions.length > GRAPH_TIME_MACHINE_MAX_VERSIONS;
  const versions = inputVersions
    .slice(-GRAPH_TIME_MACHINE_MAX_VERSIONS)
    .map(sanitizeVersion);
  const transitions: KnowledgeGraphTransition[] = [];
  const warnings: string[] = [];
  if (truncated) {
    warnings.push(
      `只分析最近 ${GRAPH_TIME_MACHINE_MAX_VERSIONS} 个版本；更早版本未载入。`
    );
  }

  for (let index = 1; index < versions.length; index += 1) {
    const from = versions[index - 1]!;
    const to = versions[index]!;
    if (
      from.availability !== "ready"
      || to.availability !== "ready"
      || from.content === undefined
      || to.content === undefined
    ) {
      const warning = from.warning || to.warning || "相邻版本至少有一端不可读取。";
      transitions.push({
        id: `${from.id}\u0000${to.id}`,
        from,
        to,
        added: [],
        removed: [],
        unchangedCount: 0,
        changedKinds: [],
        status: "gap",
        warning
      });
      warnings.push(warning);
      continue;
    }
    const impact = buildLinkImpact(from.content, to.content);
    const changed = [...impact.added, ...impact.removed];
    transitions.push({
      id: `${from.id}\u0000${to.id}`,
      from,
      to,
      added: impact.added,
      removed: impact.removed,
      unchangedCount: impact.unchanged.length,
      changedKinds: uniqueKinds(changed),
      status: changed.length ? "changed" : "stable"
    });
  }

  return {
    versions,
    transitions,
    changedTransitions: transitions.filter(
      (transition) => transition.status === "changed"
    ),
    truncated,
    warnings: [...new Set(warnings)]
  };
}

export function filterKnowledgeGraphTransitions(
  timeline: KnowledgeGraphTimeline,
  kinds: ReadonlySet<NoteRelationKind>
): KnowledgeGraphTransition[] {
  if (kinds.size === 0) return timeline.changedTransitions;
  return timeline.changedTransitions
    .map((transition) => {
      const added = transition.added.filter((relation) => kinds.has(relation.kind));
      const removed = transition.removed.filter((relation) => kinds.has(relation.kind));
      return {
        ...transition,
        added,
        removed,
        changedKinds: uniqueKinds([...added, ...removed])
      };
    })
    .filter((transition) => transition.added.length + transition.removed.length > 0);
}
