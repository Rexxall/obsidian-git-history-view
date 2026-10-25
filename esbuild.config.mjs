import esbuild from "esbuild";
import { buildStyles } from "./scripts/build-styles.mjs";

const production = process.argv[2] === "production";

buildStyles();

const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian", "electron", "@codemirror/*", "@lezer/*"],
  format: "cjs",
  target: "es2020",
  platform: "node",
  outfile: "main.js",
  sourcemap: production ? false : "inline",
  treeShaking: true,
  minify: production,
  logLevel: "info"
});

if (production) {
  await context.rebuild();
  await context.dispose();
} else {
  await context.watch();
}
