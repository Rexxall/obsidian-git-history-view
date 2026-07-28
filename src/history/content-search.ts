const FRONTMATTER_PATTERN = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/;

export type HistoricalContentScope = "body" | "properties";

export interface HistoricalContentMatch {
  snippet: string;
  scope: HistoricalContentScope;
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
