export const VERSION_LINK_ACTION = "git-note-history";

export interface VersionLinkTarget {
  filePath: string;
  commit: string;
}

/** A link that opens one version of a note in the compare view, e.g. to cite "the version I sent". */
export function buildVersionLink(vaultName: string, filePath: string, commitHash: string): string {
  const query = [
    `vault=${encodeURIComponent(vaultName)}`,
    `file=${encodeURIComponent(filePath)}`,
    `commit=${encodeURIComponent(commitHash)}`
  ].join("&");
  return `obsidian://${VERSION_LINK_ACTION}?${query}`;
}

export function buildVersionMarkdownLink(
  vaultName: string,
  filePath: string,
  commitHash: string,
  label: string
): string {
  const text = label.replace(/[[\]]/g, "");
  return `[${text}](${buildVersionLink(vaultName, filePath, commitHash)})`;
}

/** Obsidian hands protocol parameters over already decoded. */
export function parseVersionLinkParams(params: Record<string, string | undefined>): VersionLinkTarget | null {
  const filePath = (params.file ?? "").trim();
  const commit = (params.commit ?? "").trim().toLowerCase();
  if (!filePath || !/^[0-9a-f]{7,64}$/.test(commit)) return null;
  return { filePath, commit };
}
