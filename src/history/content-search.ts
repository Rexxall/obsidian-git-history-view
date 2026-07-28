const FRONTMATTER_PATTERN = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/;

export type HistoricalContentScope = "body" | "properties";

export interface HistoricalContentMatch {
  snippet: string;
  scope: HistoricalContentScope;
}

export type ContentPresenceState = "present" | "absent" | "unknown";

export interface ContentLifecycleVersion {
  key: string;
  state: ContentPresenceState;
}

export interface ContentPresenceSpan {
  firstKey: string;
  lastKey: string;
  introducedAfterKey: string | undefined;
  removedByKey: string | undefined;
  uncertainStart: boolean;
  uncertainEnd: boolean;
}

export interface ContentLifecycle {
  spans: ContentPresenceSpan[];
  firstAppearanceKey: string | undefined;
  lastPresenceKey: string | undefined;
  currentPresent: boolean;
  confirmedReappearances: number;
  unknownVersions: number;
}

export function searchableMarkdownBody(content: string): string {
  return content.replace(FRONTMATTER_PATTERN, "");
}

function sourceSnippet(
  source: string,
  query: string,
  contextCharacters = 84
): string | null {
  const normalizedQuery = query.trim();
  if (normalizedQuery.length < 2) return null;
  const index = source.toLocaleLowerCase().indexOf(normalizedQuery.toLocaleLowerCase());
  if (index < 0) return null;

  const start = Math.max(0, index - contextCharacters);
  const end = Math.min(source.length, index + normalizedQuery.length + contextCharacters);
  const before = start > 0 ? "…" : "";
  const after = end < source.length ? "…" : "";
  const excerpt = source.slice(start, end).replace(/\s+/g, " ").trim();
  return `${before}${excerpt}${after}`;
}

export function historicalContentMatch(
  content: string,
  query: string,
  contextCharacters = 84
): HistoricalContentMatch | null {
  const bodySnippet = sourceSnippet(searchableMarkdownBody(content), query, contextCharacters);
  if (bodySnippet) return { snippet: bodySnippet, scope: "body" };

  const frontmatter = content.match(FRONTMATTER_PATTERN)?.[0] ?? "";
  const propertySnippet = sourceSnippet(frontmatter, query, contextCharacters);
  return propertySnippet ? { snippet: propertySnippet, scope: "properties" } : null;
}

export function historicalContentSnippet(
  content: string,
  query: string,
  contextCharacters = 84
): string | null {
  return historicalContentMatch(content, query, contextCharacters)?.snippet ?? null;
}

export function buildContentLifecycle(
  versions: ContentLifecycleVersion[]
): ContentLifecycle {
  const spans: ContentPresenceSpan[] = [];
  let index = 0;

  while (index < versions.length) {
    if (versions[index]?.state !== "present") {
      index += 1;
      continue;
    }

    const firstIndex = index;
    while (versions[index + 1]?.state === "present") index += 1;
    const lastIndex = index;
    const previous = versions[firstIndex - 1];
    const next = versions[lastIndex + 1];

    spans.push({
      firstKey: versions[firstIndex]!.key,
      lastKey: versions[lastIndex]!.key,
      introducedAfterKey: previous?.state === "absent" ? previous.key : undefined,
      removedByKey: next?.state === "absent" ? next.key : undefined,
      uncertainStart: firstIndex > 0 && previous?.state === "unknown",
      uncertainEnd: lastIndex < versions.length - 1 && next?.state === "unknown"
    });
    index += 1;
  }

  return {
    spans,
    firstAppearanceKey: spans[0]?.firstKey,
    lastPresenceKey: spans.at(-1)?.lastKey,
    currentPresent: versions.at(-1)?.state === "present",
    confirmedReappearances: spans.slice(1).filter((span) => span.introducedAfterKey).length,
    unknownVersions: versions.filter((version) => version.state === "unknown").length
  };
}
