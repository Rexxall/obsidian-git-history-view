export class App {}

export class FileSystemAdapter {}

export class Notice {
  constructor(
    public readonly message: string,
    public readonly timeout?: number
  ) {}
}

export class TFile {
  constructor(public path = "") {}
}

function splitInline(value: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  let quote: "'" | "\"" | null = null;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote) {
      if (character === quote && value[index - 1] !== "\\") quote = null;
      continue;
    }
    if (character === "'" || character === "\"") {
      quote = character;
    } else if (character === "[" || character === "{") {
      depth += 1;
    } else if (character === "]" || character === "}") {
      depth -= 1;
    } else if (character === "," && depth === 0) {
      parts.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  if (quote || depth !== 0) throw new Error("Invalid inline YAML value.");
  parts.push(value.slice(start).trim());
  return parts.filter(Boolean);
}

function scalarYaml(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("[") || trimmed.endsWith("]")) {
    if (!(trimmed.startsWith("[") && trimmed.endsWith("]"))) {
      throw new Error("Invalid YAML list.");
    }
    const body = trimmed.slice(1, -1).trim();
    return body ? splitInline(body).map(scalarYaml) : [];
  }
  if (trimmed.startsWith("{") || trimmed.endsWith("}")) {
    if (!(trimmed.startsWith("{") && trimmed.endsWith("}"))) {
      throw new Error("Invalid YAML object.");
    }
    const result: Record<string, unknown> = {};
    const body = trimmed.slice(1, -1).trim();
    for (const entry of body ? splitInline(body) : []) {
      const separator = entry.indexOf(":");
      if (separator <= 0) throw new Error("Invalid YAML object entry.");
      const key = entry.slice(0, separator).trim().replace(/^['"]|['"]$/gu, "");
      result[key] = scalarYaml(entry.slice(separator + 1));
    }
    return result;
  }
  if (trimmed.startsWith("\"")) {
    if (!trimmed.endsWith("\"")) throw new Error("Invalid quoted YAML string.");
    return JSON.parse(trimmed) as unknown;
  }
  if (trimmed.startsWith("'")) {
    if (!trimmed.endsWith("'")) throw new Error("Invalid quoted YAML string.");
    return trimmed.slice(1, -1).replace(/''/gu, "'");
  }
  if (/^(?:null|~)$/iu.test(trimmed)) return null;
  if (/^(?:true|false)$/iu.test(trimmed)) return trimmed.toLocaleLowerCase() === "true";
  if (/^[-+]?(?:\d+\.?\d*|\.\d+)$/u.test(trimmed)) return Number(trimmed);
  if (/[[\]{}]/u.test(trimmed)) throw new Error("Invalid YAML collection.");
  return trimmed.replace(/\s+#.*$/u, "").trim();
}

export function parseYaml(yaml: string): unknown {
  const result: Record<string, unknown> = {};
  let collectionKey: string | null = null;
  let collection: unknown[] | Record<string, unknown> | null = null;

  for (const rawLine of yaml.split(/\r?\n/u)) {
    if (!rawLine.trim() || /^\s*#/u.test(rawLine)) continue;
    const indent = rawLine.match(/^\s*/u)?.[0].length ?? 0;
    const line = rawLine.trim();
    if (indent > 0) {
      if (!collectionKey) throw new Error("Unexpected YAML indentation.");
      if (line.startsWith("- ")) {
        if (collection && !Array.isArray(collection)) {
          throw new Error("Mixed YAML collection types.");
        }
        collection ??= [];
        collection.push(scalarYaml(line.slice(2)));
      } else {
        if (Array.isArray(collection)) throw new Error("Mixed YAML collection types.");
        collection ??= {};
        const separator = line.indexOf(":");
        if (separator <= 0) throw new Error("Invalid nested YAML property.");
        const key = line.slice(0, separator).trim();
        collection[key] = scalarYaml(line.slice(separator + 1));
      }
      result[collectionKey] = collection;
      continue;
    }

    collectionKey = null;
    collection = null;
    const separator = line.indexOf(":");
    if (separator <= 0) throw new Error("Invalid YAML property.");
    const key = line.slice(0, separator).trim().replace(/^['"]|['"]$/gu, "");
    if (!key) throw new Error("Empty YAML property name.");
    const value = line.slice(separator + 1);
    if (value.trim()) {
      result[key] = scalarYaml(value);
    } else {
      collectionKey = key;
      result[key] = null;
    }
  }
  return result;
}

export function getLanguage(): string {
  return "zh";
}
