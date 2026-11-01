import type { GitWorkspaceChange } from "../models";
import { tr } from "../i18n";

export type WorkspaceChangeTone =
  | "conflict"
  | "new"
  | "renamed"
  | "deleted"
  | "restaged"
  | "staged"
  | "modified";

export interface WorkspaceChangePresentation {
  key: WorkspaceChangeTone;
  label: string;
  description: string;
  icon: string;
}

export interface WorkspaceNoteLabel {
  title: string;
  folder: string;
}

const CHANGE_ORDER: WorkspaceChangeTone[] = [
  "conflict",
  "restaged",
  "staged",
  "modified",
  "new",
  "renamed",
  "deleted"
];

export function workspaceChangePresentation(
  change: GitWorkspaceChange
): WorkspaceChangePresentation {
  if (change.conflicted) {
    return {
      key: "conflict",
      label: tr("需要解决冲突", "Conflicts to resolve"),
      description: tr("Git 无法自动合并这些笔记", "Git could not merge these notes"),
      icon: "triangle-alert"
    };
  }
  if (change.untracked) {
    return {
      key: "new",
      label: tr("新笔记", "New note"),
      description: tr("Git 尚未记录", "Not yet in Git"),
      icon: "file-plus-2"
    };
  }
  if (change.indexStatus === "R") {
    return {
      key: "renamed",
      label: tr("已改名", "Renamed"),
      description: tr("笔记路径发生变化", "The note's path changed"),
      icon: "file-pen-line"
    };
  }
  if (change.indexStatus === "D" || change.workTreeStatus === "D") {
    return {
      key: "deleted",
      label: tr("已删除", "Deleted"),
      description: tr("可从 Git 历史恢复", "Can be restored from Git history"),
      icon: "file-x-2"
    };
  }
  if (change.indexStatus !== " " && change.workTreeStatus !== " ") {
    return {
      key: "restaged",
      label: tr("暂存后又修改", "Changed after staging"),
      description: tr("同时包含已准备与新修改", "Has both staged and new edits"),
      icon: "layers-3"
    };
  }
  if (change.indexStatus !== " ") {
    return {
      key: "staged",
      label: tr("已准备提交", "Staged"),
      description: tr("已经加入 Git 暂存区", "Added to the Git staging area"),
      icon: "circle-check"
    };
  }
  return {
    key: "modified",
    label: tr("已修改", "Modified"),
    description: tr("尚未加入 Git 暂存区", "Not yet staged in Git"),
    icon: "file-diff"
  };
}

export function workspaceNoteLabel(path: string): WorkspaceNoteLabel {
  const parts = path.split("/").filter(Boolean);
  const filename = parts.at(-1) ?? path;
  const title = filename.replace(/\.md$/i, "") || filename;
  const folders = parts.slice(0, -1);
  return {
    title,
    folder: folders.length > 0 ? folders.slice(-2).join(" / ") : tr("库根目录", "Vault root")
  };
}

export function groupWorkspaceChanges(
  changes: GitWorkspaceChange[]
): Array<{ presentation: WorkspaceChangePresentation; changes: GitWorkspaceChange[] }> {
  const grouped = new Map<
    WorkspaceChangeTone,
    { presentation: WorkspaceChangePresentation; changes: GitWorkspaceChange[] }
  >();
  for (const change of changes) {
    const presentation = workspaceChangePresentation(change);
    const existing = grouped.get(presentation.key);
    if (existing) {
      existing.changes.push(change);
    } else {
      grouped.set(presentation.key, { presentation, changes: [change] });
    }
  }
  return CHANGE_ORDER.flatMap((key) => {
    const group = grouped.get(key);
    return group ? [group] : [];
  });
}
