export type NoteRelationKind = "wikilink" | "markdown" | "embed" | "tag";

export interface NoteRelation {
  key: string;
  target: string;
  label: string;
  kind: NoteRelationKind;
}

export interface LinkImpact {
  added: NoteRelation[];
  removed: NoteRelation[];
  unchanged: NoteRelation[];
}

function cleanTarget(value: string): string {
  return decodeURIComponent(value.trim())
    .replace(/^<|>$/g, "")
    .split("|")[0]!
    .split("#")[0]!
    .trim();
}

function isInternalTarget(value: string): boolean {
  return Boolean(value) && !/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(value);
}

function addRelation(map: Map<string, NoteRelation>, relation: Omit<NoteRelation, "key">): void {
  const key = `${relation.kind}\u001f${relation.target.toLocaleLowerCase()}`;
  if (!map.has(key)) map.set(key, { ...relation, key });
}

export function extractNoteRelations(content: string): NoteRelation[] {
  const relations = new Map<string, NoteRelation>();
  const wikiPattern = /(!?)\[\[([^\]]+)\]\]/g;
  for (const match of content.matchAll(wikiPattern)) {
    const raw = match[2] ?? "";
    const target = cleanTarget(raw);
    if (!target) continue;
    const alias = raw.split("|")[1]?.trim();
    addRelation(relations, {
      target,
      label: alias || target,
      kind: match[1] ? "embed" : "wikilink"
    });
  }

  const markdownPattern = /(!?)\[[^\]]*\]\(([^)]+)\)/g;
  for (const match of content.matchAll(markdownPattern)) {
    const target = cleanTarget((match[2] ?? "").split(/\s+["']/)[0] ?? "");
    if (!isInternalTarget(target)) continue;
    addRelation(relations, {
      target,
      label: target,
      kind: match[1] ? "embed" : "markdown"
    });
  }

  const tagPattern = /(^|[\s(])#([\p{L}\p{N}_/-]+)/gmu;
  for (const match of content.matchAll(tagPattern)) {
    const target = match[2]?.replace(/\/$/, "") ?? "";
    if (!target) continue;
    addRelation(relations, { target, label: `#${target}`, kind: "tag" });
  }
  return [...relations.values()];
}

export function buildLinkImpact(before: string, after: string): LinkImpact {
  const previous = new Map(extractNoteRelations(before).map((relation) => [relation.key, relation]));
  const next = new Map(extractNoteRelations(after).map((relation) => [relation.key, relation]));
  return {
    added: [...next.values()].filter((relation) => !previous.has(relation.key)),
    removed: [...previous.values()].filter((relation) => !next.has(relation.key)),
    unchanged: [...next.values()].filter((relation) => previous.has(relation.key))
  };
}
