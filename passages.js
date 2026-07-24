// Passage (.twee) language features.
//
// The TypeScript language-service plugin puts a projected .ts sibling for every
// .twee file into the workspace's configured project, so passage code sees the
// generated `setup`/variable types and the story's own sources. This module is
// the editor half: it maps positions between the .twee document and its
// projection, and asks tsserver about the projection.
//
// ---------------------------------------------------------------------------
// WHAT THE TRANSPORT ALLOWS (measured against VS Code's TypeScript extension)
//
// Requests reach tsserver through the `typescript.tsserverRequest` command,
// which is registered by the built-in TypeScript extension but is NOT part of
// its documented API. It enforces an allowlist and silently returns `undefined`
// for anything else:
//
//     emit-output, semanticDiagnosticsSync, syntacticDiagnosticsSync,
//     suggestionDiagnosticsSync, quickinfo, quickinfo-full, completionInfo
//     (plus any command starting with "_")
//
// So hover, completion and diagnostics are available; `projectInfo`,
// `definitionAndBoundSpan` and `updateOpen` are NOT. Two consequences shape
// everything below:
//
//   1. `updateOpen` is blocked, so we can't push a buffer to tsserver the normal
//      way. Instead the plugin accepts the raw twee text via `configurePlugin`
//      and overrides disk with it (see pushLiveText / clearLiveText), so passage
//      intelligence tracks the UNSAVED buffer. Before the live channel existed,
//      features were suppressed on a dirty document because tsserver only saw the
//      saved file; now they aren't.
//   2. Go-to-definition cannot come from tsserver, so it is resolved here by
//      scanning the workspace for the assignment that created the member.
// ---------------------------------------------------------------------------
const vscode = require("vscode");
const twee = require("./ts-plugin/twee.js");

const TSSERVER_REQUEST = "typescript.tsserverRequest";
const SELECTOR = { scheme: "file", pattern: twee.TWEE_GLOB };

// A user-visible log (Output -> "Twine SugarCube Passages"). The provider layer
// can't be exercised outside a real extension host, so when something here
// misbehaves the only way to find out where is to say so out loud.
let channel = null;
const log = (message) => {
  try {
    if (!channel) channel = vscode.window.createOutputChannel("Twine SugarCube Passages");
    channel.appendLine(message);
  } catch (e) { /* logging is best-effort */ }
};

// Only a POSITIVE result is cached. The TypeScript extension activates lazily,
// so an early probe — the first diagnostics refresh runs during register(),
// before anything has activated it — legitimately finds the command missing.
// Caching that made every later hover and diagnostic fail for the rest of the
// session, and whether it happened at all came down to activation timing.
let available = false;

async function tsserverAvailable() {
  if (available) return true;
  try {
    // Ask for the TypeScript extension by name rather than waiting for
    // something else to activate it.
    const ext = vscode.extensions.getExtension("vscode.typescript-language-features");
    if (ext && !ext.isActive) await ext.activate();
    const commands = await vscode.commands.getCommands(true);
    available = commands.includes(TSSERVER_REQUEST);
  } catch (e) {
    available = false;
  }
  return available;
}

// Opening a .twee file does not make VS Code load a TypeScript project — the
// TypeScript extension only starts one for files it owns. Without a loaded
// project tsserver answers every request with "No Project.", the plugin's
// getExternalFiles never runs, and the projection doesn't exist as far as
// tsserver is concerned. Measured: with only the .twee open, quickinfo throws
// No Project; after any .ts file is opened, the identical request succeeds.
//
// So open one real TypeScript file in the background. It is never shown.
// IMPORTANT: VS Code owns TextDocument lifecycle — a document that isn't
// displayed in an editor can be closed by the editor at any time (holding a JS
// reference does not prevent it), and closing it lets tsserver release the
// project. register()'s onDidCloseTextDocument handler clears this so the next
// request re-warms instead of assuming a project that no longer exists.
let warmDocument = null;
async function ensureProjectLoaded() {
  if (warmDocument) return true;
  try {
    const files = await vscode.workspace.findFiles("**/*.{ts,js,mjs,cjs}", "**/node_modules/**", 1);
    if (!files.length) {
      log("no .ts/.js file in the workspace to load a TypeScript project from");
      return false; // not cached: one may appear later
    }
    warmDocument = await vscode.workspace.openTextDocument(files[0]);
    log(`loaded a TypeScript project via ${files[0].fsPath}`);
    return true;
  } catch (e) {
    log(`could not load a TypeScript project: ${e && e.message}`);
    return false;
  }
}

async function request(command, args) {
  if (!(await tsserverAvailable())) {
    log(`request(${command}) skipped: ${TSSERVER_REQUEST} is not registered`);
    return null;
  }
  await ensureProjectLoaded();
  try {
    const response = await vscode.commands.executeCommand(TSSERVER_REQUEST, command, args);
    return response && response.body ? response.body : null;
  } catch (e) {
    // Surface the reason. Swallowing these is why "NO RESPONSE" was all anyone
    // ever saw, for three different underlying causes.
    log(`request(${command}) failed: ${String(e && e.message).split("\n")[0]}`);
    return null;
  }
}

// The projected file's path, matching what the plugin registers.
const projectedPath = (document) => document.uri.fsPath.split("\\").join("/") + ".ts";
const tweePath = (document) => document.uri.fsPath.split("\\").join("/");

const projections = new Map(); // document uri -> { text, projection }

// --- live (unsaved) buffers -------------------------------------------------
// tsserver only ever sees files on disk, and the request allowlist blocks
// updateOpen, so the extension can't push a buffer the normal way. Instead the
// plugin accepts the raw twee text through configurePlugin and overrides disk
// with it. We push the live text (debounced) as the user types, so passage
// intelligence tracks the buffer without a save, and clear the override when the
// document closes so the plugin reverts to disk.
const PLUGIN_ID = "tw-sugarcube-ts-plugin";
const pushed = new Map(); // twee path -> last text pushed, to skip no-op sends
let tsApi = null;
const liveApiReady = () => !!(tsApi && typeof tsApi.configurePlugin === "function");
// register() parks a callback here so features suppressed while the live
// channel wasn't up yet (see the dirty-document gates in locate/refresh) can be
// re-run the moment it is.
let onLiveApiReady = null;

function setLiveApi(api) {
  tsApi = api;
  if (liveApiReady() && onLiveApiReady) onLiveApiReady();
}

// The full set of live buffers, as the `liveDocs` payload field. EVERY
// configurePlugin call carries it (including the settings-only send in
// extension.js): VS Code replays only the LAST payload after a tsserver
// restart, so a payload that named just one file would silently drop every
// other open buffer's override on restart — the plugin would answer from disk
// for dirty documents while `pushed` still claimed they were current.
function liveDocsSnapshot() {
  return Object.fromEntries(pushed);
}

function sendLiveDocs(reason) {
  try {
    tsApi.configurePlugin(PLUGIN_ID, {
      strict: vscode.workspace.getConfiguration("twSugarcube").get("strict", true),
      typoDetection: vscode.workspace.getConfiguration("twSugarcube").get("typoDetection", false),
      liveDocs: liveDocsSnapshot(),
    });
    return true;
  } catch (e) {
    log(`configurePlugin (${reason}) failed: ${e && e.message}`);
    return false;
  }
}

function pushLiveText(document, text) {
  if (!liveApiReady()) return;
  const path = tweePath(document);
  const prev = pushed.get(path);
  if (prev === text) return; // nothing changed since the last push
  pushed.set(path, text);
  if (!sendLiveDocs("live push")) {
    // The plugin never saw this text; roll back so the next call retries
    // instead of skipping as "already pushed".
    if (prev === undefined) pushed.delete(path); else pushed.set(path, prev);
  }
}

function clearLiveText(document) {
  if (!liveApiReady()) return;
  const path = tweePath(document);
  if (!pushed.has(path)) return;
  const prev = pushed.get(path);
  pushed.delete(path);
  // On a failed send the plugin still holds the old override — restore the
  // record to match, so a later successful send clears it for real.
  if (!sendLiveDocs("live clear")) pushed.set(path, prev);
}

function projectionOf(document) {
  const key = document.uri.toString();
  const text = document.getText();
  const cached = projections.get(key);
  if (cached && cached.text === text) return cached.projection;
  let projection;
  try {
    projection = twee.project(text);
  } catch (e) {
    projection = { ts: "", segments: [] };
  }
  projections.set(key, { text, projection });
  return projection;
}

// The plugin serves the live buffer we push (see pushLiveText), so a dirty
// document is fine — tsserver's copy matches our projection. It's only unusable
// when there's no projected code at all.
const usable = (document) => !!projectionOf(document).ts.trim();

// tsserver speaks 1-based line/offset; VS Code speaks 0-based line/character.
// Both directions work from a line-starts array (computed once per projection
// and cached on it) rather than re-splitting/slicing the text per call — the
// diagnostics refresh converts two spans per diagnostic, which made the old
// slice-and-split quadratic on a large passage.
function tsLineStarts(projection) {
  return projection._lineStarts || (projection._lineStarts = lineStartsOf(projection.ts));
}

function toTsPosition(lineStarts, offset) {
  const line = lineOfOffset(lineStarts, offset);
  return { line: line + 1, offset: offset - lineStarts[line] + 1 };
}

function offsetOfTsPosition(lineStarts, line, offset) {
  const idx = Math.min(Math.max(line - 1, 0), lineStarts.length - 1);
  return lineStarts[idx] + offset - 1;
}

function locate(document, position) {
  if (!usable(document)) return null;
  // Until the live channel is up (extension.js activates the TypeScript
  // extension between register() and setLiveApi()), tsserver only sees disk —
  // mapping its answers through a dirty buffer's projection would misplace
  // every span. Suppress features on dirty documents for that window, exactly
  // as before the live channel existed; setLiveApi re-runs the refreshes.
  if (document.isDirty && !liveApiReady()) return null;
  // Make sure tsserver has this exact buffer before we query it. The debounced
  // change handler usually got here first; this covers a query fired inside the
  // debounce window. tsserver processes requests in order, so the configurePlugin
  // push lands before the quickinfo/completion request that follows.
  pushLiveText(document, document.getText());
  const projection = projectionOf(document);
  const tsOffset = twee.tweeOffsetToTs(projection.segments, document.offsetAt(position));
  if (tsOffset === null) return null;
  return { projection, file: projectedPath(document), ...toTsPosition(tsLineStarts(projection), tsOffset) };
}

function toTweeRange(document, projection, span) {
  const lineStarts = tsLineStarts(projection);
  const start = offsetOfTsPosition(lineStarts, span.start.line, span.start.offset);
  const end = offsetOfTsPosition(lineStarts, span.end.line, span.end.offset);
  const mapped = twee.tsRangeToTwee(projection.segments, start, Math.max(0, end - start));
  if (!mapped) return null;
  return new vscode.Range(
    document.positionAt(mapped.start),
    document.positionAt(mapped.start + mapped.length)
  );
}

// --- go-to-definition -------------------------------------------------------
// tsserver can't answer this for us, so find the assignment that created the
// member. This mirrors what the language-service plugin does with a real AST;
// here we only have text, so the patterns are deliberately conservative — a
// missed jump is recoverable, a wrong one is not.
const CONTAINERS = {
  setup: /(^|[^\w$.])setup\s*(?:\.\s*([A-Za-z_$][\w$]*)|\[\s*['"]([^'"]+)['"]\s*\])\s*=(?!=)/,
  storyVariables: /(^|[^\w$.])State\s*\.\s*variables\s*(?:\.\s*([A-Za-z_$][\w$]*)|\[\s*['"]([^'"]+)['"]\s*\])\s*=(?!=)/,
  temporary: /(^|[^\w$.])State\s*\.\s*temporary\s*(?:\.\s*([A-Za-z_$][\w$]*)|\[\s*['"]([^'"]+)['"]\s*\])\s*=(?!=)/,
  settings: /(^|[^\w$.])settings\s*(?:\.\s*([A-Za-z_$][\w$]*)|\[\s*['"]([^'"]+)['"]\s*\])\s*=(?!=)/,
};

// Identify what the cursor is on, in the PROJECTION (where sigils have already
// become State.variables.x), then search for its assignment.
function memberAtProjection(projection, tsOffset) {
  const text = projection.ts;
  let start = tsOffset;
  while (start > 0 && /[\w$]/.test(text[start - 1])) start--;
  let end = tsOffset;
  while (end < text.length && /[\w$]/.test(text[end])) end++;
  const name = text.slice(start, end);
  if (!name) return null;
  const before = text.slice(Math.max(0, start - 40), start);
  const at = (container) => ({ container, name, tsStart: start, tsEnd: end });
  // The lookbehind matters: without it `mysetup.foo` reads as the container
  // `setup` and F12 jumps to an unrelated assignment. A wrong jump is the one
  // failure this provider must not produce (the CONTAINERS regexes carry the
  // same guard as `(^|[^\w$.])`).
  if (/(?<![\w$.])setup\s*\.\s*$/.test(before)) return at("setup");
  if (/(?<![\w$.])State\s*\.\s*variables\s*\.\s*$/.test(before)) return at("storyVariables");
  if (/(?<![\w$.])State\s*\.\s*temporary\s*\.\s*$/.test(before)) return at("temporary");
  if (/(?<![\w$.])settings\s*\.\s*$/.test(before)) return at("settings");
  return null;
}

// Byte offset of each line start, computed once per file. offset->line/char is
// then a binary search and the line text is a slice, instead of re-splitting or
// re-slicing the whole file for every match (the old positionOfOffset did a
// `text.slice(0, offset)` per call and the caller a `text.split("\n")` per hit —
// quadratic on a large file with many assignments).
function lineStartsOf(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  return starts;
}
function lineOfOffset(lineStarts, offset) {
  let lo = 0, hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= offset) lo = mid; else hi = mid - 1;
  }
  return lo;
}

// Every container-member assignment in `text`, as { name, nameOffset } where
// nameOffset points at the member NAME itself. Anchoring on the capture group's
// own span (via the regex `d`/indices flag) matters: searching from the match
// start with indexOf would find the name inside the container when the name is a
// substring of it — `setup.up` finds "up" in "setup", `State.variables.aria`
// finds "aria" in "variables" — and jump into the keyword instead of the member.
function* assignmentsIn(text, container) {
  const pattern = CONTAINERS[container];
  if (!pattern) return;
  const global = new RegExp(pattern.source, "gd");
  let match;
  while ((match = global.exec(text))) {
    const name = match[2] || match[3];
    if (!name) continue;
    // group 2 = dotted member, group 3 = bracketed member; exactly one matches.
    const span = match.indices && (match.indices[2] || match.indices[3]);
    // Fallback if indices are unavailable: the member name is the last identifier
    // token in the match (the container comes first), so lastIndexOf is safe.
    const nameOffset = span ? span[0] : match.index + match[0].lastIndexOf(name);
    yield { name, nameOffset };
  }
}

// File text cache, invalidated by mtime. findAssignments runs on every F12 and
// definition request, and — worst case — once per document link RESOLVE, so a
// passage with N container references reread the whole workspace N times. Caching
// by mtime means later calls re-read only files that actually changed.
// Twee files carry their projection too, computed once per (re)read.
const fileCache = new Map(); // uri string -> { mtime, text, lineStarts, projection? }
const FILE_CACHE_CAP = 4096; // bound the cache over a long session

async function readCached(uri) {
  // Read bytes rather than `openTextDocument`: opening a .ts file from inside a
  // definition request pulls the TypeScript extension into the middle of the
  // call, and we only need text. stat first so an unchanged file is never reread.
  let stat;
  try { stat = await vscode.workspace.fs.stat(uri); } catch (e) { return null; }
  const key = uri.toString();
  const hit = fileCache.get(key);
  if (hit && hit.mtime === stat.mtime) return hit;
  let text;
  try {
    text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
  } catch (e) { return null; }
  if (fileCache.size >= FILE_CACHE_CAP) fileCache.clear();
  const entry = { mtime: stat.mtime, text, lineStarts: lineStartsOf(text) };
  if (twee.isTweeFile(uri.fsPath || "")) {
    try { entry.projection = twee.project(text); } catch (e) { /* skip this file */ }
  }
  fileCache.set(key, entry);
  return entry;
}

// Map a member-name span in a projection back to the twee document. In a
// verbatim segment (`State.variables.hp = 1` written out in a macro) the name
// maps exactly; in a rewritten one (`$hp` -> `State.variables.hp`) the whole
// sigil is the selection — there is no narrower author-written span to point at.
function tweeSpanOfName(segments, nameOffset, nameLength) {
  for (const s of segments) {
    if (nameOffset >= s.tsStart && nameOffset <= s.tsStart + s.tsLength) {
      if (s.tsLength === s.tweeLength) {
        return { start: s.tweeStart + (nameOffset - s.tsStart), length: nameLength };
      }
      return { start: s.tweeStart, length: s.tweeLength };
    }
  }
  return null;
}

// Sources that can create a container member: TypeScript/JavaScript, and the
// passages themselves — `<<set $hp to 10>>` is how most story variables come
// into existence, so twee files are scanned via their projection (where the
// sigil has already become `State.variables.hp =`) and hits are mapped back
// onto the author's text.
const ASSIGNMENT_SOURCES_GLOB = `**/*.{ts,js,mjs,cjs,${twee.TWEE_EXTENSIONS.join(",")}}`;

// One workspace sweep (findFiles + a stat per file), memoized briefly. A
// document-link resolve calls findAssignments once per individual link, so a
// ctrl-hover burst repeated the identical sweep back to back; per-file CONTENT
// staleness is still governed by readCached's mtime check — only the file list
// and stat results ride the memo, bounding staleness to SWEEP_TTL_MS.
const SWEEP_TTL_MS = 2000;
let sweep = { at: 0, read: null };

async function sweepSources() {
  if (sweep.read && Date.now() - sweep.at < SWEEP_TTL_MS) return sweep.read;
  const files = await vscode.workspace.findFiles(ASSIGNMENT_SOURCES_GLOB, "**/node_modules/**", 2000);
  log(`  sweeping ${files.length} file(s)`);
  // Read (or reuse) files in concurrent batches rather than awaiting one at a
  // time — the sequential await was the bulk of the latency on a large workspace.
  const BATCH = 48;
  const read = [];
  for (let i = 0; i < files.length; i += BATCH) {
    const chunk = files.slice(i, i + BATCH);
    const got = await Promise.all(chunk.map((uri) => readCached(uri).then((e) => (e ? { uri, ...e } : null))));
    for (const e of got) if (e) read.push(e);
  }
  sweep = { at: Date.now(), read };
  return read;
}

// Every member name assigned on `container` anywhere in the workspace. This is
// the completion fallback for a bare sigil, where the projection has nothing
// for tsserver to complete at yet.
async function memberNamesFor(container) {
  const names = new Set();
  for (const { text, projection } of await sweepSources()) {
    const haystack = projection ? projection.ts : text;
    for (const { name } of assignmentsIn(haystack, container)) names.add(name);
  }
  return names;
}

async function findAssignments(container, name) {
  if (!CONTAINERS[container]) return [];
  const read = await sweepSources();
  log(`  scanning ${read.length} file(s) for ${container}.${name}`);
  const locations = [];
  const locationAt = (uri, text, lineStarts, startOffset, length) => {
    const line = lineOfOffset(lineStarts, startOffset);
    const lineStart = lineStarts[line];
    const character = startOffset - lineStart;
    const lineEnd = line + 1 < lineStarts.length ? lineStarts[line + 1] - 1 : text.length;
    const lineText = text.slice(lineStart, lineEnd).replace(/\r$/, "");
    // Whole-line target range so a peek shows the assignment, with the member
    // name (or the whole sigil, for a passage) as the selection.
    return {
      targetUri: uri,
      targetRange: new vscode.Range(
        new vscode.Position(line, 0),
        new vscode.Position(line, lineText.length)
      ),
      targetSelectionRange: new vscode.Range(
        new vscode.Position(line, character),
        new vscode.Position(line, character + length)
      ),
    };
  };
  for (const { uri, text, lineStarts, projection } of read) {
    if (projection) {
      // A twee file: search the projection (never the raw text — a literal
      // `State.variables.x =` inside a macro is projected verbatim, so scanning
      // both would double-report it), then map each hit back to the source.
      for (const { name: found, nameOffset } of assignmentsIn(projection.ts, container)) {
        if (found !== name) continue;
        const span = tweeSpanOfName(projection.segments, nameOffset, found.length);
        if (!span) continue;
        locations.push(locationAt(uri, text, lineStarts, span.start, span.length));
      }
    } else {
      for (const { name: found, nameOffset } of assignmentsIn(text, container)) {
        if (found !== name) continue;
        locations.push(locationAt(uri, text, lineStarts, nameOffset, found.length));
      }
    }
  }
  return locations;
}

// Map the container expression as it appears in the projection to a CONTAINERS key.
function containerKey(expression) {
  const flat = expression.replace(/\s+/g, "");
  if (flat === "setup") return "setup";
  if (flat === "State.variables") return "storyVariables";
  if (flat === "State.temporary") return "temporary";
  if (flat === "settings") return "settings";
  return null;
}

function register(context) {
  const hover = vscode.languages.registerHoverProvider(SELECTOR, {
    async provideHover(document, position) {
      const at = locate(document, position);
      if (!at) {
        log(`hover: no mapping (dirty=${document.isDirty}) at offset ${document.offsetAt(position)}`);
        return null;
      }
      const info = await request("quickinfo", { file: at.file, line: at.line, offset: at.offset });
      log(`hover: ${at.file} ${at.line}:${at.offset} -> ${info ? JSON.stringify(info.displayString) : "NO RESPONSE"}`);
      if (!info || !info.displayString) return null;
      const md = new vscode.MarkdownString();
      md.appendCodeblock(info.displayString, "typescript");
      if (info.documentation) md.appendMarkdown("\n" + info.documentation);
      return new vscode.Hover(md, toTweeRange(document, at.projection, info) || undefined);
    },
  });

  const completion = vscode.languages.registerCompletionItemProvider(SELECTOR, {
    async provideCompletionItems(document, position) {
      // A bare sigil — `$` or `_` with no identifier after it yet — projects to
      // NOTHING (prose) or a verbatim `$` (macro), so the tsserver path below
      // structurally cannot return variable members at the very moment the
      // trigger characters fire. Serve the workspace's known members directly:
      // the same regex machinery go-to-definition trusts.
      const offset = document.offsetAt(position);
      const text = document.getText();
      const sigil = text[offset - 1];
      if (sigil === "$" || sigil === "_") {
        const before = text[offset - 2];
        const after = text[offset];
        // Token start (not `setup.$`, `a$`, or the `$$`/`__` escapes), and
        // nothing typed after the sigil yet.
        const atTokenStart = !(before && (/[\w$]/.test(before) || before === "." || before === sigil));
        const bare = after === undefined || !/[\w$]/.test(after);
        if (atTokenStart && bare) {
          const names = await memberNamesFor(sigil === "$" ? "storyVariables" : "temporary");
          return [...names].map((name) => {
            const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Variable);
            item.sortText = "0" + name;
            return item;
          });
        }
      }
      // A member access the author has only half-typed — `$player.` with nothing
      // after the dot yet. Inside a macro the projection carries the dot and
      // TypeScript answers natively. In PROSE it deliberately does not: a
      // sentence ending `You have $gold.` is not a member access, and projecting
      // that dot would put an "Identifier expected" on text the author wrote
      // correctly. So the offset just after the dot maps to nothing at all, and
      // the query below would never be sent.
      //
      // Ask at the DOT's own offset instead — that maps to the end of the
      // projected expression — and flag the trigger, which is the plugin's cue
      // to fill in that expression's members (see memberCompletionsAt).
      const onDot = text[offset - 1] === ".";
      let at = locate(document, position);
      // Only where a dot could actually continue an expression: after an
      // identifier or a closing bracket, never after prose or whitespace.
      if (!at && onDot && offset >= 2 && /[\w$\])]/.test(text[offset - 2])) {
        at = locate(document, document.positionAt(offset - 1));
      }
      if (!at) return null;
      const args = {
        file: at.file, line: at.line, offset: at.offset,
        includeExternalModuleExports: false, includeInsertTextCompletions: true,
      };
      if (onDot) args.triggerCharacter = ".";
      const info = await request("completionInfo", args);
      const entries = (info && info.entries) || [];
      // An explicit (empty) replacement range at the cursor. Without one VS Code
      // derives the range from the document's word pattern — and .twee is owned
      // by another extension, whose pattern is free to include the `.` we just
      // completed at. Every entry would then be filtered against `$player.` and
      // none would match, showing nothing while the provider believed it had
      // answered. (The same class of failure the definition provider hit.)
      const range = onDot ? new vscode.Range(position, position) : undefined;
      return entries.map((entry) => {
        const item = new vscode.CompletionItem(entry.name);
        item.sortText = entry.sortText;
        item.detail = entry.kind;
        if (range) item.range = range;
        return item;
      });
    },
  }, ".", "$", "_");

  const definition = vscode.languages.registerDefinitionProvider(SELECTOR, {
    async provideDefinition(document, position) {
      // Unlike hover, this reads only the projection's own text, so it works on
      // a dirty buffer too.
      try {
        const projection = projectionOf(document);
        const offset = document.offsetAt(position);
        const tsOffset = twee.tweeOffsetToTs(projection.segments, offset);
        log(`definition: ${document.uri.fsPath} offset=${offset} -> ts=${tsOffset}`);
        if (tsOffset === null) return null;
        const member = memberAtProjection(projection, tsOffset);
        log(`  member=${JSON.stringify(member)}`);
        if (!member) return null;
        const found = await findAssignments(member.container, member.name);
        if (!found.length) { log("  no assignment found"); return null; }

        // Return LocationLinks with an explicit origin range rather than bare
        // Locations. A bare Location makes VS Code infer the clickable span from
        // the document's word pattern — and .twee is owned by another extension
        // whose word pattern doesn't treat `playerName` inside `<<= setup.x()>>`
        // as a word, so a perfectly good result rendered no link at all.
        const span = twee.tsRangeToTwee(projection.segments, member.tsStart, member.tsEnd - member.tsStart);
        const origin = span
          ? new vscode.Range(document.positionAt(span.start), document.positionAt(span.start + span.length))
          : undefined;
        log(`  origin=${origin ? `${origin.start.line}:${origin.start.character}-${origin.end.character}` : "(none)"}` +
            ` targets=${found.map((l) => l.targetUri.fsPath).join(", ")}`);
        return found.map((link) => ({ ...link, originSelectionRange: origin }));
      } catch (e) {
        // A throw here is swallowed by VS Code and looks identical to "no
        // definition", which is precisely how this stayed invisible.
        log(`  THREW: ${e && e.stack ? e.stack : e}`);
        return null;
      }
    },
  });

  // --- clickable links (independent of the definition machinery) ------------
  // The definition provider returns correct, well-formed LocationLinks that VS
  // Code declines to render in a .twee document (verified from the extension's
  // own log: right member, right origin range, right target, no link). Document
  // links are a separate mechanism the editor renders and navigates itself, so
  // ctrl+click works even when definition links don't.
  const links = vscode.languages.registerDocumentLinkProvider(SELECTOR, {
    provideDocumentLinks(document) {
      try {
        // Default false, matching package.json — this is an opt-in workaround, so
        // the fallback must not silently turn it on where the contribution's
        // declared default isn't applied.
        if (!vscode.workspace.getConfiguration("twSugarcube").get("passageLinks", false)) return [];
        const projection = projectionOf(document);
        const out = [];
        // Every container member reference in the projection.
        // Lookbehind so `mysetup.foo` doesn't get a link to `setup.foo`.
        const re = /(?<![\w$.])(setup|State\s*\.\s*variables|State\s*\.\s*temporary|settings)\s*\.\s*([A-Za-z_$][\w$]*)/g;
        let m;
        while ((m = re.exec(projection.ts))) {
          const name = m[2];
          const nameStart = m.index + m[0].lastIndexOf(name);
          const span = twee.tsRangeToTwee(projection.segments, nameStart, name.length);
          if (!span) continue;
          const range = new vscode.Range(
            document.positionAt(span.start), document.positionAt(span.start + span.length)
          );
          // Only offer a link where the author actually wrote the name; a
          // rewritten sigil maps onto `$hp`, which is a legitimate target too.
          const link = new vscode.DocumentLink(range);
          link.tooltip = `Go to ${m[1].replace(/\s+/g, "")}.${name}`;
          link._member = { container: containerKey(m[1]), name };
          out.push(link);
        }
        log(`links: ${out.length} in ${document.uri.fsPath}`);
        return out;
      } catch (e) {
        log(`links THREW: ${e && e.stack ? e.stack : e}`);
        return [];
      }
    },
    // Resolve lazily so opening a file doesn't scan the workspace once per link.
    async resolveDocumentLink(link) {
      try {
        const member = link._member;
        if (!member) return link;
        const found = await findAssignments(member.container, member.name);
        if (!found.length) { log(`  link ${member.name}: no assignment`); return link; }
        const target = found[0];
        const line = target.targetSelectionRange.start.line;
        const character = target.targetSelectionRange.start.character;
        // The fragment is what makes VS Code land on the right line.
        link.target = target.targetUri.with({ fragment: `L${line + 1},${character + 1}` });
        log(`  link ${member.name} -> ${link.target.fsPath}#L${line + 1}`);
        return link;
      } catch (e) {
        log(`  link resolve THREW: ${e && e.stack ? e.stack : e}`);
        return link;
      }
    },
  });

  // --- our own Go to Definition ---------------------------------------------
  // F12 and ctrl+click both route through VS Code's definition aggregation,
  // which collects every registered provider with Promise.all. Twee 3 Language
  // Tools registers a definition provider for `twee3-sugarcube-2` that never
  // resolves, so the aggregate never settles and NO provider's results are ever
  // used — verified in a real extension host: with that extension disabled our
  // results arrive instantly, with it enabled every selector variant hangs.
  //
  // This command sidesteps the aggregation entirely. package.json binds it to
  // F12 for passage files, so the normal keystroke works.
  const goToDefinition = vscode.commands.registerCommand("twSugarcube.goToDefinition", async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const document = editor.document;
    if (!vscode.languages.match(SELECTOR, document)) {
      // Not a passage — fall back to the built-in behaviour.
      return vscode.commands.executeCommand("editor.action.revealDefinition");
    }
    try {
      const projection = projectionOf(document);
      const tsOffset = twee.tweeOffsetToTs(projection.segments, document.offsetAt(editor.selection.active));
      const member = tsOffset === null ? null : memberAtProjection(projection, tsOffset);
      log(`goToDefinition: member=${JSON.stringify(member)}`);
      if (!member) return;
      const found = await findAssignments(member.container, member.name);
      if (!found.length) {
        vscode.window.setStatusBarMessage(`No assignment found for ${member.name}`, 3000);
        return;
      }
      const target = found[0];
      const shown = await vscode.window.showTextDocument(target.targetUri, { preserveFocus: false });
      shown.selection = new vscode.Selection(
        target.targetSelectionRange.start, target.targetSelectionRange.end
      );
      shown.revealRange(target.targetRange, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      log(`  navigated to ${target.targetUri.fsPath}`);
    } catch (e) {
      log(`goToDefinition THREW: ${e && e.stack ? e.stack : e}`);
    }
  });

  // --- diagnostics ---
  const diagnostics = vscode.languages.createDiagnosticCollection("twSugarcubePassages");
  // Latest refresh sequence per document. Two refreshes can be in flight at once
  // (an open and a save, or a debounced edit and a save); the awaited request
  // means the slower one can resolve last and clobber the newer diagnostics with
  // a stale answer. Each refresh stamps a sequence and bails if it's been
  // superseded by the time its response arrives.
  const refreshSeq = new Map(); // uri -> latest sequence number

  async function refresh(document) {
    if (!vscode.languages.match(SELECTOR, document)) return;
    // Same gate as locate(): with the live channel down, tsserver's answer
    // describes the DISK text, and converting its spans through the dirty
    // buffer's projection would pin diagnostics to the wrong places — and they
    // would stick until the next edit. setLiveApi re-runs this refresh.
    if (document.isDirty && !liveApiReady()) return;
    const key = document.uri.toString();
    const seq = (refreshSeq.get(key) || 0) + 1;
    refreshSeq.set(key, seq);
    if (!usable(document)) { diagnostics.delete(document.uri); return; }
    // Push the current buffer, then query — tsserver applies the two in order.
    pushLiveText(document, document.getText());
    const projection = projectionOf(document);
    // With typo detection off the containers carry an index signature, so a
    // member reference never legitimately errors as nonexistent; with it on, the
    // containers are deliberately closed and "does not exist" is exactly how a
    // real typo surfaces. So the suppression below is only sound in the off case.
    const typoDetection = vscode.workspace.getConfiguration("twSugarcube").get("typoDetection", false);
    const body = await request("semanticDiagnosticsSync", { file: projectedPath(document) });
    // A newer refresh for this document started while we awaited; its answer is
    // fresher, so drop ours rather than overwrite it with a stale one.
    if (refreshSeq.get(key) !== seq) return;
    if (!Array.isArray(body)) { diagnostics.delete(document.uri); return; }
    const out = [];
    for (const d of body) {
      if (!d.start || !d.end || !d.text) continue;
      // A projection that tsserver hasn't adopted into the configured project
      // resolves `setup` to the empty shipped interface, making every member
      // look nonexistent. With typo detection off those reports are always wrong
      // (a genuine unknown member is never an error), so drop them. With it on,
      // dropping them would swallow the very typos it exists to find — and the
      // plugin's own diagnostics proxy already suppresses these while generation
      // is failing, so a truly unadopted projection stays quiet regardless.
      if (!typoDetection && /does not exist on type 'SugarCube/.test(d.text)) continue;
      const range = toTweeRange(document, projection, d);
      if (!range) continue; // scaffolding we emitted, not the author's text
      out.push(new vscode.Diagnostic(
        range, d.text,
        d.category === "warning" ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Error
      ));
    }
    diagnostics.set(document.uri, out);
  }

  // Push the live buffer as the user types, debounced so we don't reconfigure
  // the plugin on every keystroke, then refresh diagnostics from it.
  const debounced = new Map(); // uri -> timeout handle
  function onEdit(document) {
    if (!vscode.languages.match(SELECTOR, document)) return;
    const key = document.uri.toString();
    if (debounced.has(key)) clearTimeout(debounced.get(key));
    debounced.set(key, setTimeout(() => {
      debounced.delete(key);
      pushLiveText(document, document.getText());
      refresh(document);
    }, 200));
  }

  context.subscriptions.push(
    hover, completion, definition, links, goToDefinition, diagnostics,
    vscode.workspace.onDidOpenTextDocument((doc) => refresh(doc)),
    vscode.workspace.onDidSaveTextDocument((doc) => refresh(doc)),
    vscode.workspace.onDidChangeTextDocument((event) => onEdit(event.document)),
    vscode.workspace.onDidCloseTextDocument((doc) => {
      const key = doc.uri.toString();
      // The warm document's lifecycle belongs to VS Code — it can be closed at
      // any time, which lets tsserver release the project. Forget it so
      // ensureProjectLoaded re-warms on the next request instead of returning
      // true forever against a released project.
      if (warmDocument && key === warmDocument.uri.toString()) warmDocument = null;
      if (debounced.has(key)) { clearTimeout(debounced.get(key)); debounced.delete(key); }
      clearLiveText(doc); // plugin reverts to disk for this file
      projections.delete(key);
      // refreshSeq is deliberately KEPT: deleting it on close reset the
      // counter, so a stale in-flight refresh from before a close could carry
      // the same seq as a fresh one after a quick reopen and clobber its
      // diagnostics. The map is bounded by the twee files touched in a session.
      diagnostics.delete(doc.uri);
    })
  );
  // The F12 binding is gated on a context key so the setting can turn it off;
  // `when` clauses can't read settings directly.
  const applyToggles = () => {
    const enabled = vscode.workspace.getConfiguration("twSugarcube").get("passageGoToDefinition", false);
    vscode.commands.executeCommand("setContext", "twSugarcube.passageGoToDefinition", enabled);
  };
  applyToggles();
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("twSugarcube.passageGoToDefinition")) applyToggles();
    })
  );

  // register() runs before extension.js has activated the TypeScript extension
  // and handed us the API, so dirty documents restored by hot exit skip their
  // first refresh (see the gates in locate/refresh). Re-run them when the live
  // channel comes up.
  onLiveApiReady = () => {
    log("live channel up: refreshing open passage documents");
    for (const doc of vscode.workspace.textDocuments) refresh(doc);
  };

  log(`registered passage providers for ${JSON.stringify(SELECTOR)}`);
  for (const doc of vscode.workspace.textDocuments) {
    if (vscode.languages.match(SELECTOR, doc)) {
      log(`  matched open document: ${doc.uri.fsPath} (languageId=${doc.languageId})`);
    }
    refresh(doc);
  }
}

// The transport's allowlist, mirrored here so a test can assert that every
// command this module sends is actually permitted. Sending anything else fails
// SILENTLY (the command returns undefined), which is how an entire release
// shipped with hover and go-to-definition dead.
const ALLOWED_COMMANDS = [
  "emit-output", "semanticDiagnosticsSync", "syntacticDiagnosticsSync",
  "suggestionDiagnosticsSync", "quickinfo", "quickinfo-full", "completionInfo",
];

module.exports = {
  register,
  setLiveApi,
  liveDocsSnapshot,
  ALLOWED_COMMANDS,
  // exposed for tests
  __test: {
    memberAtProjection, CONTAINERS, assignmentsIn, findAssignments, tweeSpanOfName,
    lineStartsOf, lineOfOffset, toTsPosition, offsetOfTsPosition, tsserverAvailable,
    memberNamesFor, resetSweep: () => { sweep = { at: 0, read: null }; },
  },
};
