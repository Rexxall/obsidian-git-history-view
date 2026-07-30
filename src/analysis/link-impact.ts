export type NoteRelationKind =
  | "wikilink"
  | "markdown"
  | "embed"
  | "attachment"
  | "tag"
  | "footnote";

export interface NoteRelation {
  key: string;
  target: string;
  label: string;
  kind: NoteRelationKind;
  subpath?: string;
}

export interface LinkImpact {
  added: NoteRelation[];
  removed: NoteRelation[];
  unchanged: NoteRelation[];
}

interface ParsedTarget {
  target: string;
  subpath?: string;
}

function cleanTarget(value: string): ParsedTarget {
  const trimmed = value.trim();
  let decoded = trimmed;
  try {
    decoded = decodeURIComponent(trimmed);
  } catch {
    // Keep malformed historical links inspectable instead of failing the whole impact view.
  }
  const withoutAlias = decoded
    .replace(/^<|>$/g, "")
    .split("|")[0]!
    .trim();
  const subpathIndex = [
    withoutAlias.indexOf("#"),
    withoutAlias.indexOf("^")
  ]
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0];
  if (subpathIndex === undefined) return { target: withoutAlias };
  return {
    target: withoutAlias.slice(0, subpathIndex).trim(),
    subpath: withoutAlias.slice(subpathIndex).trim()
  };
}

function isInternalTarget(value: string): boolean {
  return Boolean(value) && !/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(value);
}

function addRelation(
  map: Map<string, NoteRelation>,
  relation: Omit<NoteRelation, "key">
): void {
  const key = [
    relation.kind,
    relation.target.toLocaleLowerCase(),
    relation.subpath?.toLocaleLowerCase() ?? ""
  ].join("\u001f");
  if (!map.has(key)) map.set(key, { ...relation, key });
}

function relationKindForEmbed(target: string): NoteRelationKind {
  const extension = target
    .split("/")
    .at(-1)
    ?.match(/\.([^.]+)$/u)?.[1]
    ?.toLocaleLowerCase();
  return extension && extension !== "md" ? "attachment" : "embed";
}

export function isVaultTargetRelation(relation: NoteRelation): boolean {
  return relation.kind !== "tag" && relation.kind !== "footnote";
}

export function extractNoteRelations(content: string): NoteRelation[] {
  const relations = new Map<string, NoteRelation>();
  const wikiPattern = /(!?)\[\[([^\]]+)\]\]/g;
  for (const match of content.matchAll(wikiPattern)) {
    const raw = match[2] ?? "";
    const parsed = cleanTarget(raw);
    if (!parsed.target) continue;
    const alias = raw.split("|")[1]?.trim();
    addRelation(relations, {
      target: parsed.target,
      label: alias || parsed.target,
      kind: match[1] ? relationKindForEmbed(parsed.target) : "wikilink",
      ...(parsed.subpath ? { subpath: parsed.subpath } : {})
    });
  }

  const markdownPattern = /(!?)\[[^\]]*\]\(([^)]+)\)/g;
  for (const match of content.matchAll(markdownPattern)) {
    const parsed = cleanTarget((match[2] ?? "").split(/\s+["']/)[0] ?? "");
    if (!isInternalTarget(parsed.target)) continue;
    addRelation(relations, {
      target: parsed.target,
      label: parsed.target,
      kind: match[1] ? relationKindForEmbed(parsed.target) : "markdown",
      ...(parsed.subpath ? { subpath: parsed.subpath } : {})
    });
  }

  const tagPattern = /(^|[\s(])#([\p{L}\p{N}_/-]+)/gmu;
  for (const match of content.matchAll(tagPattern)) {
    const target = match[2]?.replace(/\/$/, "") ?? "";
    if (!target) continue;
    addRelation(relations, { target, label: `#${target}`, kind: "tag" });
  }

  const footnotePattern = /\[\^([^\]\r\n]+)\](?!:)/gmu;
  for (const match of content.matchAll(footnotePattern)) {
    const target = match[1]?.trim() ?? "";
    if (!target) continue;
    addRelation(relations, {
      target,
      label: `[^${target}]`,
      kind: "footnote"
    });
  }
  return [...relations.values()];
}

export function buildLinkImpact(before: string, after: string): LinkImpact {
  const previous = new Map(
    extractNoteRelations(before).map((relation) => [relation.key, relation])
  );
  const next = new Map(
    extractNoteRelations(after).map((relation) => [relation.key, relation])
  );
  return {
    added: [...next.values()].filter((relation) => !previous.has(relation.key)),
    removed: [...previous.values()].filter((relation) => !next.has(relation.key)),
    unchanged: [...next.values()].filter((relation) => previous.has(relation.key))
  };
}
