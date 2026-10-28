import { getLanguage } from "obsidian";

/** The history views are written in Chinese; entry points also speak English for everyone else. */
export function isChineseInterface(): boolean {
  try {
    return getLanguage().toLowerCase().startsWith("zh");
  } catch {
    return true;
  }
}

export function tr(zh: string, en: string): string {
  return isChineseInterface() ? zh : en;
}
