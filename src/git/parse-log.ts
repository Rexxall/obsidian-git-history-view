import type {
  GitCommittedChange,
  GitCommitVersion,
  GitFileStatus,
  GitLineStats,
  ReviewCommitSummary,
  GitWorkspaceChange
} from "../models";

const RECORD_SEPARATOR = "\u001e";
const FIELD_SEPARATOR = "\u001f";
const BODY_SEPARATOR = "\u001d";

interface NameStatusEntry {
  status: string;
  oldPath?: string;
  path: string;
}

function parseNameStatusLine(line: string): NameStatusEntry | null {
  const parts = line.split("\t");
  const status = parts[0]?.trim();
  if (!status) return null;

  if ((status.startsWith("R") || status.startsWith("C")) && parts.length >= 3) {
    const oldPath = parts[1];
    const path = parts[2];
    if (!oldPath || !path) return null;
    return { status, oldPath, path };
  }

  const path = parts[1];
  if (!path) return null;
  return { status, path };
}

export function parseGitLog(raw: string, currentPath: string): GitCommitVersion[] {
  const commits: GitCommitVersion[] = [];
  let historicalPath = currentPath;

  for (const rawRecord of raw.split(RECORD_SEPARATOR)) {
    const record = rawRecord.replace(/^\r?\n/, "").trimEnd();
    if (!record) continue;

    const bodySeparator = record.indexOf(BODY_SEPARATOR);
    const firstNewline = record.indexOf("\n");
    const headerEnd = bodySeparator >= 0 ? bodySeparator : firstNewline;
    const header = headerEnd >= 0 ? record.slice(0, headerEnd) : record;
    const body =
      bodySeparator >= 0
        ? record.slice(bodySeparator + BODY_SEPARATOR.length).replace(/^\r?\n/, "")
        : firstNewline >= 0
          ? record.slice(firstNewline + 1)
          : "";
    const fields = header.split(FIELD_SEPARATOR);
    if (fields.length < 6) continue;

    const [hash, shortHash, authorName, authorEmail, authoredAt, subject = "", messageBody = ""] =
      fields;
    if (!hash || !shortHash || !authorName || !authorEmail || !authoredAt) continue;

    const entries = body
      .split(/\r?\n/)
      .map(parseNameStatusLine)
      .filter((entry): entry is NameStatusEntry => entry !== null);

    const pathAtCommit = historicalPath;
    const relevantEntry =
      entries.find((entry) => entry.path === pathAtCommit) ??
      entries.find((entry) => entry.oldPath === pathAtCommit) ??
      entries[0];

    commits.push({
      hash,
      shortHash,
      authorName,
      authorEmail,
      authoredAt,
      subject,
      historicalPath: pathAtCommit,
      changeType: relevantEntry?.status.charAt(0) || "M",
      addedLines: 0,
      deletedLines: 0,
      trailers: parseCommitTrailers(messageBody)
    });

    const pathChange = entries.find(
      (entry) =>
        (entry.status.startsWith("R") || entry.status.startsWith("C"))
        && entry.path === historicalPath
        && entry.oldPath
    );
    if (pathChange?.oldPath) historicalPath = pathChange.oldPath;
  }

  return commits;
}

export function parseCommitTrailers(messageBody: string): Record<string, string> {
  const trailers: Record<string, string> = {};
  for (const line of messageBody.split(/\r?\n/)) {
    const match = /^([A-Za-z][A-Za-z0-9-]*):\s*(.+)$/.exec(line.trim());
    if (!match?.[1] || !match[2]) continue;
    const key = match[1].toLowerCase();
    if (["agent", "authority", "send-gate", "workflow-status"].includes(key)) {
      trailers[key] = match[2].trim();
    }
  }
  return trailers;
}

export function parseNumStatLog(raw: string): Map<string, GitLineStats> {
  const result = new Map<string, GitLineStats>();
  for (const rawRecord of raw.split(RECORD_SEPARATOR)) {
    const record = rawRecord.replace(/^\r?\n/, "").trim();
    if (!record) continue;
    const [hashLine, ...statLines] = record.split(/\r?\n/);
    const hash = hashLine?.trim();
    if (!hash) continue;

    let addedLines = 0;
    let deletedLines = 0;
    let binary = false;
    for (const line of statLines) {
      const [added, deleted] = line.split("\t");
      if (added === "-" || deleted === "-") {
        binary = true;
        continue;
      }
      const addedNumber = Number.parseInt(added ?? "", 10);
      const deletedNumber = Number.parseInt(deleted ?? "", 10);
      if (Number.isFinite(addedNumber)) addedLines += addedNumber;
      if (Number.isFinite(deletedNumber)) deletedLines += deletedNumber;
    }
    result.set(hash, { addedLines, deletedLines, binary });
  }
  return result;
}

export function parseSingleNumStat(raw: string): GitLineStats {
  let addedLines = 0;
  let deletedLines = 0;
  let binary = false;
  for (const line of raw.split(/\r?\n/)) {
    const [added, deleted] = line.split("\t");
    if (added === "-" || deleted === "-") {
      binary = true;
      continue;
    }
    const addedNumber = Number.parseInt(added ?? "", 10);
    const deletedNumber = Number.parseInt(deleted ?? "", 10);
    if (Number.isFinite(addedNumber)) addedLines += addedNumber;
    if (Number.isFinite(deletedNumber)) deletedLines += deletedNumber;
  }
  return { addedLines, deletedLines, binary };
}

export function parseNumStatByPath(raw: string): Map<string, GitLineStats> {
  const result = new Map<string, GitLineStats>();
  for (const line of raw.split(/\r?\n/)) {
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const added = parts[0];
    const deleted = parts[1];
    const filePath = parts.slice(2).join("\t");
    if (!filePath) continue;
    result.set(filePath, {
      addedLines: added === "-" ? 0 : Number.parseInt(added ?? "0", 10) || 0,
      deletedLines: deleted === "-" ? 0 : Number.parseInt(deleted ?? "0", 10) || 0,
      binary: added === "-" || deleted === "-"
    });
  }
  return result;
}

const CONFLICT_CODES = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

export function parseGitStatus(raw: string): GitFileStatus {
  const firstLine = raw.split(/\r?\n/).find((line) => line.length >= 2) ?? "";
  const code = firstLine.slice(0, 2);
  const untracked = code === "??";

  return {
    raw: firstLine,
    staged: !untracked && code.length === 2 && code[0] !== " ",
    unstaged: untracked || (code.length === 2 && code[1] !== " "),
    untracked,
    conflicted: CONFLICT_CODES.has(code)
  };
}

export function parseWorkspaceStatus(raw: string): GitWorkspaceChange[] {
  const records = raw.split("\0");
  const changes: GitWorkspaceChange[] = [];

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record || record.length < 4) continue;
    const indexStatus = record[0] ?? " ";
    const workTreeStatus = record[1] ?? " ";
    const path = record.slice(3);
    let originalPath: string | undefined;

    if (indexStatus === "R" || indexStatus === "C") {
      originalPath = records[index + 1] || undefined;
      index += 1;
    }

    const code = `${indexStatus}${workTreeStatus}`;
    const untracked = code === "??";
    const change: GitWorkspaceChange = {
      path,
      indexStatus,
      workTreeStatus,
      untracked,
      conflicted: CONFLICT_CODES.has(code),
      addedLines: 0,
      deletedLines: 0
    };
    if (originalPath) change.originalPath = originalPath;
    changes.push(change);
  }

  return changes;
}

export function parseCommittedNameStatus(raw: string): GitCommittedChange[] {
  const records = raw.split("\0");
  const changes: GitCommittedChange[] = [];

  for (let index = 0; index < records.length; index += 1) {
    const status = records[index]?.trim();
    if (!status) continue;

    if (status.startsWith("R") || status.startsWith("C")) {
      const originalPath = records[index + 1];
      const path = records[index + 2];
      index += 2;
      if (!originalPath || !path) continue;
      changes.push({
        path,
        originalPath,
        changeType: status.charAt(0),
        addedLines: 0,
        deletedLines: 0
      });
      continue;
    }

    const path = records[index + 1];
    index += 1;
    if (!path) continue;
    changes.push({
      path,
      changeType: status.charAt(0),
      addedLines: 0,
      deletedLines: 0
    });
  }

  return changes;
}

export function parseLatestCommitByPath(raw: string): Map<string, ReviewCommitSummary> {
  const result = new Map<string, ReviewCommitSummary>();

  for (const rawRecord of raw.split(RECORD_SEPARATOR)) {
    const record = rawRecord.replace(/^\r?\n/, "").trimEnd();
    if (!record) continue;
    const bodySeparator = record.indexOf(BODY_SEPARATOR);
    const header = bodySeparator >= 0 ? record.slice(0, bodySeparator) : record;
    const body = bodySeparator >= 0 ? record.slice(bodySeparator + BODY_SEPARATOR.length) : "";
    const [hash, shortHash, authoredAt, subject = ""] = header.split(FIELD_SEPARATOR);
    if (!hash || !shortHash || !authoredAt) continue;
    const summary: ReviewCommitSummary = { hash, shortHash, authoredAt, subject };

    for (const line of body.replace(/^\r?\n/, "").split(/\r?\n/)) {
      const entry = parseNameStatusLine(line);
      if (!entry) continue;
      if (!result.has(entry.path)) result.set(entry.path, summary);
    }
  }

  return result;
}
