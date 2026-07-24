import type { GitWorkspaceChange } from "../models";

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
      label: "需要解决冲突",
      description: "Git 无法自动合并这些笔记",
      icon: "triangle-alert"
    };
  }
  if (change.untracked) {
    return {
      key: "new",
      label: "新笔记",
      description: "Git 尚未记录",
      icon: "file-plus-2"
    };
  }
  if (change.indexStatus === "R") {
    return {
      key: "renamed",
      label: "已改名",
      description: "笔记路径发生变化",
      icon: "file-pen-line"
    };
  }
  if (change.indexStatus === "D" || change.workTreeStatus === "D") {
    return {
      key: "deleted",
      label: "已删除",
      description: "可从 Git 历史恢复",
      icon: "file-x-2"
    };
  }
  if (change.indexStatus !== " " && change.workTreeStatus !== " ") {
    return {
      key: "restaged",
      label: "暂存后又修改",
      description: "同时包含已准备与新修改",
      icon: "layers-3"
    };
  }
  if (change.indexStatus !== " ") {
    return {
      key: "staged",
      label: "已准备提交",
      description: "已经加入 Git 暂存区",
      icon: "circle-check"
    };
  }
  return {
    key: "modified",
    label: "已修改",
    description: "尚未加入 Git 暂存区",
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
    folder: folders.length > 0 ? folders.slice(-2).join(" / ") : "库根目录"
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
