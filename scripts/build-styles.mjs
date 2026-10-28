import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const parts = ["apple-kit.css", "core.css", "lab.css", "glass.css"];

export function buildStyles() {
  const banner = "/* Built from styles/*.css by scripts/build-styles.mjs. Edit the sources, not this file. */\n\n";
  const css = parts
    .map((name) => `/* ===== styles/${name} ===== */\n\n${readFileSync(resolve(root, "styles", name), "utf8").trimEnd()}\n`)
    .join("\n");
  writeFileSync(resolve(root, "styles.css"), banner + css);
  return css;
}

if (process.argv[1] === import.meta.filename) {
  const css = buildStyles();
  const important = (css.match(/!important/g) ?? []).length;
  console.log(`styles.css: ${css.split("\n").length} lines, ${important} !important`);
}
