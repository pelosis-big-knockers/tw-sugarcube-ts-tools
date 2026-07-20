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
  // Position/Range capture their args so tests can assert on returned ranges.
  Position: class { constructor(line, character) { this.line = line; this.character = character; } },
  Range: class { constructor(start, end) { this.start = start; this.end = end; } },
  Location: class {}, Hover: class {},
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

  // Regression: a container-lookalike suffix must not read as the container —
  // `mysetup.foo` claimed the container `setup` and F12 jumped to an unrelated
  // `setup.foo` assignment.
  const lookalike = twee.project("<<run mysetup.attack(3)>>");
  check("mysetup.attack is not mistaken for setup.attack",
    memberAtProjection(lookalike, lookalike.ts.indexOf("attack")) === null, "false positive");
  const stateLookalike = twee.project("<<run GameState.variables.hp>>");
  check("GameState.variables.hp is not mistaken for State.variables.hp",
    memberAtProjection(stateLookalike, stateLookalike.ts.indexOf("hp")) === null, "false positive");
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

// --- 5. the member offset points at the member, not into the container ------
// Regression: the name offset was found with indexOf from the match start, which
// lands inside the container when the member name is a substring of it — jumping
// into the keyword instead of the member (`setup.up` -> the "up" in "setup").
{
  const { assignmentsIn } = passages.__test;
  const only = (container, text) => [...assignmentsIn(text, container)];
  const nameAt = (text, container) => {
    const [a] = only(container, text);
    return a && text.slice(a.nameOffset, a.nameOffset + a.name.length);
  };

  // "up" is a substring of "setup"; "aria" is a substring of "variables".
  const up = only("setup", "setup.up = 1;")[0];
  check("setup.up points at the member 'up', not into 'setup'",
    !!up && up.name === "up" && "setup.up = 1;".slice(up.nameOffset, up.nameOffset + 2) === "up" &&
      up.nameOffset === "setup.".length,
    JSON.stringify(up));
  check("setup.e points at the trailing member 'e'",
    nameAt("setup.e = 1;", "setup") === "e");
  const aria = only("storyVariables", "State.variables.aria = 3;")[0];
  check("State.variables.aria points at 'aria', not the 'aria' inside 'variables'",
    !!aria && aria.nameOffset === "State.variables.".length, JSON.stringify(aria));
  // A bracketed member's offset lands inside the quotes, on the name itself.
  const br = only("setup", "setup['up'] = 1;")[0];
  check("bracketed setup['up'] points at the quoted member",
    !!br && "setup['up'] = 1;".slice(br.nameOffset, br.nameOffset + 2) === "up", JSON.stringify(br));
}

// --- 6. findAssignments: correct locations, mtime cache, batched reads -------
// findAssignments runs on every F12/definition and once per link resolve, so it
// caches file text by mtime and reads concurrently. This drives it against an
// in-memory fs to check the mapped locations and that unchanged files aren't
// reread.
{
  const { findAssignments } = passages.__test;
  const files = new Map(); // path -> { text, mtime }
  files.set("/w/a.ts", { text: "setup.attack = 1;\nsetup.other = 2;\n", mtime: 1 });
  files.set("/w/b.ts", { text: "line0\nState.variables.hp = 100;\n", mtime: 1 });
  files.set("/w/c.twee", { text: ":: Start\n<<set $gold to 10>>\n", mtime: 1 });
  const uriFor = (p) => ({ _p: p, fsPath: p, toString: () => "file://" + p });
  let reads = 0;
  stub.workspace.findFiles = async () => [...files.keys()].map(uriFor);
  stub.workspace.fs = {
    stat: async (uri) => { const f = files.get(uri._p); if (!f) throw new Error("ENOENT"); return { mtime: f.mtime }; },
    readFile: async (uri) => { reads++; const f = files.get(uri._p); if (!f) throw new Error("ENOENT"); return Buffer.from(f.text, "utf8"); },
  };

  const found = await findAssignments("setup", "attack");
  check("findAssignments locates exactly the named member",
    found.length === 1 && found[0].targetUri._p === "/w/a.ts", JSON.stringify(found));
  check("...selection spans the member name on the right line",
    !!found[0] && found[0].targetSelectionRange.start.line === 0 &&
      found[0].targetSelectionRange.start.character === "setup.".length &&
      found[0].targetSelectionRange.end.character === "setup.".length + "attack".length,
    JSON.stringify(found[0] && found[0].targetSelectionRange));

  // A story variable on a non-zero line exercises the line-offset math.
  const hp = await findAssignments("storyVariables", "hp");
  check("finds a member on a later line at the right column",
    hp.length === 1 && hp[0].targetSelectionRange.start.line === 1 &&
      hp[0].targetSelectionRange.start.character === "State.variables.".length, JSON.stringify(hp[0]));

  // A variable created ONLY inside a passage (`<<set $gold to 10>>`) — the
  // common case for story variables — must be findable too: the twee file is
  // scanned via its projection and the hit mapped back onto the sigil.
  const gold = await findAssignments("storyVariables", "gold");
  check("finds a variable created only by <<set>> in a passage",
    gold.length === 1 && gold[0].targetUri._p === "/w/c.twee", JSON.stringify(gold));
  check("...selecting the whole sigil on the right line",
    !!gold[0] && gold[0].targetSelectionRange.start.line === 1 &&
      gold[0].targetSelectionRange.start.character === "<<set ".length &&
      gold[0].targetSelectionRange.end.character === "<<set $gold".length,
    JSON.stringify(gold[0] && gold[0].targetSelectionRange));

  // findAssignments calls within SWEEP_TTL_MS share one memoized sweep, which
  // would mask the mtime cache below — reset it so each call stats afresh and
  // the checks exercise the mtime cache itself.
  const { memberNamesFor, resetSweep } = passages.__test;

  // Cache: an identical follow-up call must not re-read unchanged files.
  resetSweep();
  const readsBefore = reads;
  await findAssignments("setup", "attack");
  check("unchanged files are not re-read (mtime cache)", reads === readsBefore,
    `re-read ${reads - readsBefore} unchanged file(s)`);

  // Bumping one file's mtime re-reads only that file.
  files.get("/w/a.ts").mtime = 2;
  resetSweep();
  const readsBefore2 = reads;
  await findAssignments("setup", "attack");
  check("a changed file IS re-read", reads === readsBefore2 + 1, `re-read ${reads - readsBefore2} file(s)`);

  // The memo itself: within the TTL a second sweep does not stat or read.
  let stats = 0;
  const origStat = stub.workspace.fs.stat;
  stub.workspace.fs.stat = async (uri) => { stats++; return origStat(uri); };
  await findAssignments("storyVariables", "hp"); // rides the memo from the call above
  check("a sweep within the TTL is served from the memo", stats === 0, `stat called ${stats} time(s)`);
  stub.workspace.fs.stat = origStat;

  // Bare-sigil completion fallback: every member ever assigned on the
  // container, from .ts sources and passage projections alike.
  resetSweep();
  const names = await memberNamesFor("storyVariables");
  check("memberNamesFor collects story variables from .ts and passages",
    names.has("hp") && names.has("gold") && !names.has("attack") && !names.has("other"),
    JSON.stringify([...names]));

  // Pure line-offset helpers.
  const { lineStartsOf, lineOfOffset } = passages.__test;
  const ls = lineStartsOf("ab\ncde\nf");
  check("lineStartsOf marks each line start", JSON.stringify(ls) === "[0,3,7]", JSON.stringify(ls));
  check("lineOfOffset binary-searches to the right line",
    lineOfOffset(ls, 0) === 0 && lineOfOffset(ls, 2) === 0 && lineOfOffset(ls, 3) === 1 &&
      lineOfOffset(ls, 6) === 1 && lineOfOffset(ls, 7) === 2 && lineOfOffset(ls, 8) === 2,
    "wrong line");

  // tsserver position conversion now works from the same line-starts array.
  const { toTsPosition, offsetOfTsPosition } = passages.__test;
  check("toTsPosition converts offsets to 1-based line/offset",
    JSON.stringify(toTsPosition(ls, 0)) === '{"line":1,"offset":1}' &&
      JSON.stringify(toTsPosition(ls, 4)) === '{"line":2,"offset":2}' &&
      JSON.stringify(toTsPosition(ls, 7)) === '{"line":3,"offset":1}',
    JSON.stringify([toTsPosition(ls, 0), toTsPosition(ls, 4), toTsPosition(ls, 7)]));
  check("offsetOfTsPosition inverts it (and clamps an out-of-range line)",
    offsetOfTsPosition(ls, 1, 1) === 0 && offsetOfTsPosition(ls, 2, 2) === 4 &&
      offsetOfTsPosition(ls, 3, 1) === 7 && offsetOfTsPosition(ls, 99, 1) === 7,
    "wrong offset");
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log("FAILED: " + failed.map((f) => f.name).join(", "));
  process.exit(1);
}
