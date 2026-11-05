// Measure how long the plugin's onload takes and whether it starts child processes
// (such as git) before Obsidian's layout is ready.
//
//   node scripts/measure-startup.mjs --vault <test vault> [--port 9222] [--runs 9] [--budget 50]
//
// Obsidian must already be open on that vault with --remote-debugging-port=<port>,
// and the plugin installed and enabled there. The script wraps the installed main.js
// with timing code, reloads the window several times, then puts main.js back.
// It fails when the median onload is over budget (ms) or a child process starts
// before the layout is ready. Child processes are counted for the whole window,
// so use a test vault with only this plugin enabled.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, value, index, all) => {
    if (value.startsWith("--")) pairs.push([value.slice(2), all[index + 1]]);
    return pairs;
  }, [])
);
if (!args.vault) {
  console.error("usage: node scripts/measure-startup.mjs --vault <test vault> [--port 9222] [--runs 9] [--budget 50]");
  process.exit(2);
}
const port = args.port ?? "9222";
const runs = Number(args.runs ?? 9);
const budgetMs = Number(args.budget ?? 50);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { id } = JSON.parse(readFileSync(path.join(repoRoot, "manifest.json"), "utf8"));
const installed = path.join(path.resolve(args.vault), ".obsidian", "plugins", id, "main.js");
const original = readFileSync(installed, "utf8");

const timed = `;(window.__startup=window.__startup||{})[${JSON.stringify(id)}]={evalStart:performance.now()};\n${original}
;(()=>{const R=window.__startup[${JSON.stringify(id)}];R.evalEnd=performance.now();const C=module.exports.default||module.exports;const o=C.prototype.onload;C.prototype.onload=async function(){const s=performance.now();try{return await o.apply(this,arguments)}finally{R.onload=performance.now()-s}}})();\n`;

const probe = `(() => {
  const T = window.__startupProbe = { spawns: [] };
  try {
    const cp = require("child_process");
    for (const name of ["execFile", "spawn", "exec"]) {
      const orig = cp[name];
      cp[name] = function (...rest) { T.spawns.push({ t: performance.now(), name, file: String(rest[0]) }); return orig.apply(this, rest); };
    }
  } catch (e) { T.error = String(e); }
  let current;
  Object.defineProperty(window, "app", { configurable: true, get() { return current; }, set(v) {
    current = v;
    const ready = setInterval(() => {
      if (!v || !v.workspace || !v.workspace.onLayoutReady) return;
      clearInterval(ready);
      v.workspace.onLayoutReady(() => { T.layoutReady = performance.now(); });
    }, 0);
  } });
})();`;

const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = pages.find((t) => t.type === "page" && !t.url.startsWith("devtools") && !/^(Settings|设置)/.test(t.title));
if (!page) {
  console.error(`No Obsidian window on port ${port}.`);
  process.exit(2);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve) => (ws.onopen = resolve));
let seq = 0;
const call = (method, params = {}) => new Promise((resolve) => {
  const callId = ++seq;
  const onMessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id !== callId) return;
    ws.removeEventListener("message", onMessage);
    resolve(message.result);
  };
  ws.addEventListener("message", onMessage);
  ws.send(JSON.stringify({ id: callId, method, params }));
  // Calls sent while the page reloads never answer.
  setTimeout(() => { ws.removeEventListener("message", onMessage); resolve(undefined); }, 3000);
});
const evaluate = async (expression) =>
  (await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }))?.result?.value;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const reloadAndWait = async () => {
  await call("Page.reload", { ignoreCache: true });
  for (let i = 0; i < 120; i++) {
    await sleep(250);
    if (await evaluate("!!(window.app && app.workspace && app.workspace.layoutReady)")) return;
  }
  throw new Error("Obsidian did not finish loading within 30 seconds.");
};

const samples = [];
try {
  writeFileSync(installed, timed);
  await call("Page.enable");
  // A hidden window throttles timers and makes startup look many times slower.
  await evaluate("(() => { const w = require('@electron/remote').getCurrentWindow(); w.show(); w.webContents.setBackgroundThrottling(false); return true; })()");
  await call("Page.addScriptToEvaluateOnNewDocument", { source: probe });
  // The first load after rewriting main.js reads it cold; it is not counted.
  for (let i = 0; i <= runs; i++) {
    await reloadAndWait();
    await sleep(1500);
    const sample = await evaluate(`({ plugin: (window.__startup || {})[${JSON.stringify(id)}], probe: window.__startupProbe })`);
    if (i > 0) samples.push(sample);
  }
} finally {
  writeFileSync(installed, original);
  await reloadAndWait().catch(() => undefined);
  ws.close();
}

const loaded = samples.filter((sample) => sample?.plugin?.onload !== undefined);
if (loaded.length === 0) {
  console.error(`${id} did not load. Is it installed and enabled in this vault?`);
  process.exit(1);
}
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const round = (value) => Math.round(value * 10) / 10;
const onloads = loaded.map((sample) => sample.plugin.onload);
const evals = loaded.map((sample) => sample.plugin.evalEnd - sample.plugin.evalStart);
const early = loaded.map((sample) => sample.probe.spawns.filter((spawn) => spawn.t < sample.probe.layoutReady).length);
const later = loaded.map((sample) => sample.probe.spawns.filter((spawn) => spawn.t >= sample.probe.layoutReady).length);
const result = {
  plugin: id,
  runs: loaded.length,
  onloadMedianMs: round(median(onloads)),
  onloadMaxMs: round(Math.max(...onloads)),
  evaluateMedianMs: round(median(evals)),
  childProcessesBeforeLayoutReady: Math.max(...early),
  childProcessesInFirstSecondsAfter: Math.max(...later),
  budgetMs
};
console.log(JSON.stringify(result, null, 2));
const failures = [];
if (result.onloadMedianMs > budgetMs) failures.push(`median onload ${result.onloadMedianMs} ms is over the ${budgetMs} ms budget`);
if (result.childProcessesBeforeLayoutReady > 0) failures.push(`${result.childProcessesBeforeLayoutReady} child process(es) started before the layout was ready`);
if (failures.length > 0) {
  console.error(`Startup check failed: ${failures.join("; ")}.`);
  process.exit(1);
}
console.log("Startup check passed.");
