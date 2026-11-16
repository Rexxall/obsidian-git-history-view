#!/usr/bin/env node
// Keep the facts in the READMEs that change with each release in step with manifest.json.
//
//   node scripts/docs-sync.mjs           rewrite every <!-- DOCS-SYNC:START key --> … <!-- DOCS-SYNC:END --> block
//   node scripts/docs-sync.mjs --check   change nothing; exit 1 if a block is stale or a README / README image
//                                        names an Obsidian version other than minAppVersion
//
// Keys: min (minAppVersion, trailing .0 dropped), version (plugin version), platform (desktop or mobile, in the README's language).
// Text outside the markers is never touched. A broken, nested or unknown marker stops the run with an error.
// A line that names another Obsidian version on purpose (say, what Bases needs) ends with <!-- docs-sync: ok -->.
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const check = process.argv.includes("--check");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
// "1.13.0" is written "1.13" in prose; both count as the same version.
const short = (v) => v.replace(/(\.0)+$/, "");
const min = short(manifest.minAppVersion), desktop = manifest.isDesktopOnly === true;

const lang = (file) => /\.zh(-CN)?\.md$|_zh\.md$/.test(file) ? "zh" : /\.ja\.md$/.test(file) ? "ja" : "en";
const PLATFORM = {
  en: desktop ? "desktop only" : "desktop or mobile",
  zh: desktop ? "仅限电脑" : "电脑和手机都能用",
  ja: desktop ? "デスクトップ専用" : "デスクトップとモバイルに対応",
};
const value = (key, file) => {
  if (key === "min") return min;
  if (key === "version") return manifest.version;
  if (key === "platform") return PLATFORM[lang(file)];
  return null;
};

const readmes = fs.readdirSync(root).filter((f) => /^README.*\.md$/.test(f)).sort();
const svgDir = path.join(root, "assets", "readme");
const svgs = fs.existsSync(svgDir) ? fs.readdirSync(svgDir).filter((f) => f.endsWith(".svg")).map((f) => path.join("assets", "readme", f)) : [];

const errors = [], stale = [];
for (const file of readmes) {
  const full = path.join(root, file), text = fs.readFileSync(full, "utf8");
  const tokens = [...text.matchAll(/<!--\s*DOCS-SYNC:(START|END)(?:\s+([\w-]+))?\s*-->/g)];
  let open = null;
  for (const t of tokens) {
    const line = text.slice(0, t.index).split("\n").length;
    if (t[1] === "START") {
      if (open) errors.push(`${file}:${line}: DOCS-SYNC:START inside another block (opened on line ${open.line})`);
      else if (!t[2]) errors.push(`${file}:${line}: DOCS-SYNC:START needs a key (min, version or platform)`);
      else if (value(t[2], file) === null) errors.push(`${file}:${line}: unknown DOCS-SYNC key "${t[2]}"`);
      open = { key: t[2], line };
    } else {
      if (!open) errors.push(`${file}:${line}: DOCS-SYNC:END without a START`);
      open = null;
    }
  }
  if (open) errors.push(`${file}:${open.line}: DOCS-SYNC:START never closed`);
  if (errors.length) continue;
  const next = text.replace(/(<!--\s*DOCS-SYNC:START\s+([\w-]+)\s*-->)([\s\S]*?)(<!--\s*DOCS-SYNC:END\s*-->)/g,
    (_, a, key, _old, b) => a + value(key, file) + b);
  if (next !== text) {
    stale.push(file);
    if (!check) fs.writeFileSync(full, next);
  }
}

// Versions written by hand anywhere in a README or a README image must match minAppVersion.
const mismatches = [];
for (const file of [...readmes, ...svgs]) {
  fs.readFileSync(path.join(root, file), "utf8").split("\n").forEach((line, i) => {
    if (/docs-sync:\s*ok/.test(line)) return;
    const plain = line.replace(/<!--\s*DOCS-SYNC:START\s+min\s*-->[^<]*<!--\s*DOCS-SYNC:END\s*-->/g, min);
    for (const m of plain.matchAll(/Obsidian\s*(?:v)?(\d+\.\d+(?:\.\d+)?)/gi)) {
      if (short(m[1]) !== min) mismatches.push(`${file}:${i + 1}: says Obsidian ${m[1]}, manifest.json says ${min}`);
    }
  });
}

if (errors.length) { console.error("DOCS-SYNC markers are broken; nothing was changed:\n  " + errors.join("\n  ")); process.exit(1); }
if (check && stale.length) console.error(`Stale DOCS-SYNC blocks in ${stale.join(", ")}. Run: node scripts/docs-sync.mjs`);
if (mismatches.length) console.error("Obsidian version in the docs does not match manifest.json:\n  " + mismatches.join("\n  "));
if ((check && stale.length) || mismatches.length) process.exit(1);
console.log(check ? "DOCS-SYNC: README facts match manifest.json." : stale.length ? `DOCS-SYNC: updated ${stale.join(", ")}.` : "DOCS-SYNC: nothing to update.");
