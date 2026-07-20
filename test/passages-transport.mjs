// Tests for the editor half of passage support.
//
// The motivating bug: `typescript.tsserverRequest` silently returns undefined
// for any command outside its allowlist. v0.5.0 shipped using `projectInfo`,
// `definitionAndBoundSpan` and `updateOpen` — all blocked — so hover returned
// null and ctrl+click did nothing, with no error anywhere to notice. These
// checks make that class of failure loud.
import { readFileSync, existsSync } from "fs";
import { createRequire } from "module";
import path from "path";
import { fileURLToPath } from "url";
import Module from "module";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.dirname(testDir);
const require = createRequire(import.meta.url);

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}${ok || !detail ? "" : `\n        ${detail}`}`);
};

console.log("passage transport\n");

// --- stub `vscode` so passages.js can be loaded outside the extension host ---
const stub = {
  languages: {
    registerHoverProvider: () => ({ dispose() {} }),
    registerCompletionItemProvider: () => ({ dispose() {} }),
    registerDefinitionProvider: () => ({ dispose() {} }),
    createDiagnosticCollection: () => ({ set() {}, delete() {}, dispose() {} }),
    match: () => true,
  },
  workspace: {
    textDocuments: [],
    onDidOpenTextDocument: () => ({ dispose() {} }),
    onDidSaveTextDocument: () => ({ dispose() {} }),
    onDidChangeTextDocument: () => ({ dispose() {} }),
    onDidCloseTextDocument: () => ({ dispose() {} }),
    findFiles: async () => [],
    openTextDocument: async () => ({ getText: () => "", positionAt: () => ({}) }),
  },
  commands: { getCommands: async () => [], executeCommand: async () => undefined },
  Range: class {}, Position: class {}, Location: class {}, Hover: class {},
  CompletionItem: class { constructor(name) { this.label = name; } },
  MarkdownString: class { appendCodeblock() {} appendMarkdown() {} },
  Diagnostic: class {}, DiagnosticSeverity: { Error: 0, Warning: 1 },
  Uri: { file: (p) => ({ fsPath: p }) },
};
const originalLoad = Module._load;
Module._load = function (name, ...rest) {
  if (name === "vscode") return stub;
  return originalLoad.call(this, name, ...rest);
};
delete require.cache[require.resolve(path.join(repoRoot, "passages.js"))];
const passages = require(path.join(repoRoot, "passages.js"));
Module._load = originalLoad;

// --- 1. every command we send must be allowlisted --------------------------
{
  const source = readFileSync(path.join(repoRoot, "passages.js"), "utf8");
  // Match `request("command"` calls.
  const sent = [...source.matchAll(/\brequest\(\s*"([a-zA-Z-]+)"/g)].map((m) => m[1]);
  check("the module actually sends some commands", sent.length > 0, `found ${sent.length}`);
  const blocked = sent.filter((c) => !passages.ALLOWED_COMMANDS.includes(c));
  check("every command sent is on the transport allowlist", blocked.length === 0,
    `blocked commands would fail SILENTLY: ${[...new Set(blocked)].join(", ")}`);
}

// --- 2. the mirrored allowlist must match VS Code's real one ---------------
// Best-effort: only runs when a VS Code install is present.
{
  const candidates = [
    "C:/Users/ginde/AppData/Local/Programs/Microsoft VS Code/8a7abeba6e/resources/app/extensions/typescript-language-features/dist/extension.js",
  ];
  const found = candidates.find((p) => existsSync(p));
  if (!found) {
    console.log("  SKIP  mirrored allowlist matches VS Code (no install found)");
  } else {
    const js = readFileSync(found, "utf8");
    const m = /\["emit-output",("[a-zA-Z-]+",?)+\]\.includes/.exec(js);
    const real = m ? [...m[0].matchAll(/"([a-zA-Z-]+)"/g)].map((x) => x[1]) : null;
    check("mirrored allowlist matches the installed VS Code",
      !!real && real.every((c) => passages.ALLOWED_COMMANDS.includes(c)) &&
        passages.ALLOWED_COMMANDS.every((c) => real.includes(c)),
      real ? `VS Code: ${real.join(", ")}\n        ours:    ${passages.ALLOWED_COMMANDS.join(", ")}` : "(could not parse)");
  }
}

// --- 2b. a failed availability probe must not be cached --------------------
// The TypeScript extension activates lazily, so the first probe (which happens
// during register(), before anything activates it) can legitimately find the
// command missing. Caching that killed hover and diagnostics for the whole
// session, gated only on activation timing.
{
  let registered = false;
  let activated = false;
  const lateStub = {
    ...stub,
    extensions: {
      // Activation returns before the command shows up in getCommands — the
      // realistic case, and the one that makes the first probe fail.
      getExtension: () => ({
        get isActive() { return activated; },
        activate: async () => { activated = true; },
      }),
    },
    commands: {
      getCommands: async () => (registered ? ["typescript.tsserverRequest"] : []),
      executeCommand: async () => undefined,
    },
  };
  Module._load = function (name, ...rest) {
    if (name === "vscode") return lateStub;
    return originalLoad.call(this, name, ...rest);
  };
  delete require.cache[require.resolve(path.join(repoRoot, "passages.js"))];
  const fresh = require(path.join(repoRoot, "passages.js"));
  Module._load = originalLoad;

  // Probe before the command exists...
  registered = false;
  const first = await fresh.__test.tsserverAvailable();
  // ...then again once it does. A cached `false` would keep saying no.
  registered = true;
  const second = await fresh.__test.tsserverAvailable();
  check("an early failed probe is not cached forever", second === true,
    `first=${first}, second=${second} — hover would stay dead all session`);
  check("the probe activates the TypeScript extension itself", activated === true,
    "waited for someone else to activate it");
}

// --- 3. member identification in the projection ----------------------------
{
  const { memberAtProjection } = passages.__test;
  const twee = require(path.join(repoRoot, "ts-plugin", "twee.js"));

  const cases = [
    ["<<run setup.attack(3)>>", "attack", "setup"],
    ["<<set $hp to 10>>", "hp", "storyVariables"],
    ["<<run setup.hit(_scratch)>>", "scratch", "temporary"],
    ["<<= settings.volume>>", "volume", "settings"],
  ];
  for (const [src, name, container] of cases) {
    const projection = twee.project(src);
    const at = projection.ts.indexOf(name);
    const member = memberAtProjection(projection, at);
    check(`identifies ${container}.${name}`,
      !!member && member.name === name && member.container === container,
      JSON.stringify(member));
  }

  // A bare local must not be mistaken for a container member.
  const plain = twee.project("<<run someLocal(1)>>");
  check("a non-container identifier yields no member",
    memberAtProjection(plain, plain.ts.indexOf("someLocal")) === null, "false positive");
}

// --- 4. the assignment patterns used for go-to-definition ------------------
{
  const { CONTAINERS } = passages.__test;
  const hits = (container, text) => {
    const re = new RegExp(CONTAINERS[container].source, "g");
    const out = [];
    let m;
    while ((m = re.exec(text))) out.push(m[2] || m[3]);
    return out;
  };
  check("finds a dotted setup assignment",
    hits("setup", "setup.attack = (n: number) => n;").join() === "attack");
  check("finds a bracketed setup assignment",
    hits("setup", "setup['attack'] = 1;").join() === "attack");
  check("finds a story variable assignment",
    hits("storyVariables", "State.variables.hp = 100;").join() === "hp");
  check("ignores equality comparisons",
    hits("setup", "if (setup.attack === 1) {}").length === 0, "matched an ==");
  check("ignores a lookalike on another object",
    hits("setup", "mysetup.attack = 1;").length === 0, "matched mysetup");
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log("FAILED: " + failed.map((f) => f.name).join(", "));
  process.exit(1);
}
