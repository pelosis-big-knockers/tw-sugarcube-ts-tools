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
// So open one real TypeScript file in the background. It is never shown; the
// reference is held so VS Code doesn't discard the document.
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

function setLiveApi(api) { tsApi = api; }

function pushLiveText(document, text) {
  if (!tsApi || typeof tsApi.configurePlugin !== "function") return;
  const path = tweePath(document);
  if (pushed.get(path) === text) return; // nothing changed since the last push
  pushed.set(path, text);
  try {
    tsApi.configurePlugin(PLUGIN_ID, {
      strict: vscode.workspace.getConfiguration("twSugarcube").get("strict", true),
      typoDetection: vscode.workspace.getConfiguration("twSugarcube").get("typoDetection", false),
      liveDoc: { path, text },
    });
  } catch (e) {
    log(`configurePlugin (live push) failed: ${e && e.message}`);
  }
}

function clearLiveText(document) {
  if (!tsApi || typeof tsApi.configurePlugin !== "function") return;
  const path = tweePath(document);
  if (!pushed.has(path)) return;
  pushed.delete(path);
  try {
    tsApi.configurePlugin(PLUGIN_ID, {
      strict: vscode.workspace.getConfiguration("twSugarcube").get("strict", true),
      typoDetection: vscode.workspace.getConfiguration("twSugarcube").get("typoDetection", false),
      liveDoc: { path, text: null },
    });
  } catch (e) {
    log(`configurePlugin (live clear) failed: ${e && e.message}`);
  }
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
function toTsPosition(text, offset) {
  const before = text.slice(0, offset);
  return { line: before.split("\n").length, offset: offset - (before.lastIndexOf("\n") + 1) + 1 };
}

function offsetOfTsPosition(text, line, offset) {
  const lines = text.split("\n");
  let total = 0;
  for (let i = 0; i < line - 1 && i < lines.length; i++) total += lines[i].length + 1;
  return total + offset - 1;
}

function locate(document, position) {
  if (!usable(document)) return null;
  // Make sure tsserver has this exact buffer before we query it. The debounced
  // change handler usually got here first; this covers a query fired inside the
  // debounce window. tsserver processes requests in order, so the configurePlugin
  // push lands before the quickinfo/completion request that follows.
  pushLiveText(document, document.getText());
  const projection = projectionOf(document);
  const tsOffset = twee.tweeOffsetToTs(projection.segments, document.offsetAt(position));
  if (tsOffset === null) return null;
  return { projection, file: projectedPath(document), ...toTsPosition(projection.ts, tsOffset) };
}

function toTweeRange(document, projection, span) {
  const start = offsetOfTsPosition(projection.ts, span.start.line, span.start.offset);
  const end = offsetOfTsPosition(projection.ts, span.end.line, span.end.offset);
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
  if (/setup\s*\.\s*$/.test(before)) return at("setup");
  if (/State\s*\.\s*variables\s*\.\s*$/.test(before)) return at("storyVariables");
  if (/State\s*\.\s*temporary\s*\.\s*$/.test(before)) return at("temporary");
  if (/settings\s*\.\s*$/.test(before)) return at("settings");
  return null;
}

// Offset -> {line, character}, so we never have to open a TextDocument just to
// convert a position.
function positionOfOffset(text, offset) {
  const before = text.slice(0, offset);
  const line = before.split("\n").length - 1;
  return { line, character: offset - (before.lastIndexOf("\n") + 1) };
}

async function findAssignments(container, name) {
  const pattern = CONTAINERS[container];
  if (!pattern) return [];
  const files = await vscode.workspace.findFiles("**/*.{ts,js,mjs,cjs}", "**/node_modules/**", 2000);
  log(`  scanning ${files.length} file(s) for ${container}.${name}`);
  const locations = [];
  for (const uri of files) {
    // Read bytes rather than `openTextDocument`: opening a .ts file from inside
    // a definition request pulls the TypeScript extension into the middle of the
    // call, and we only need text.
    let text;
    try {
      text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
    } catch (e) { continue; }
    // Re-scan per occurrence so we can anchor on the member name itself.
    const global = new RegExp(pattern.source, "g");
    let match;
    while ((match = global.exec(text))) {
      const found = match[2] || match[3];
      if (found !== name) continue;
      const nameOffset = text.indexOf(found, match.index);
      const from = positionOfOffset(text, nameOffset);
      const to = positionOfOffset(text, nameOffset + found.length);
      const selection = new vscode.Range(
        new vscode.Position(from.line, from.character),
        new vscode.Position(to.line, to.character)
      );
      // Whole-line target range so a peek shows the assignment, with the member
      // name itself as the selection.
      const lineText = text.split("\n")[from.line] || "";
      locations.push({
        targetUri: uri,
        targetRange: new vscode.Range(
          new vscode.Position(from.line, 0),
          new vscode.Position(from.line, lineText.replace(/\r$/, "").length)
        ),
        targetSelectionRange: selection,
      });
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
      const at = locate(document, position);
      if (!at) return null;
      const info = await request("completionInfo", {
        file: at.file, line: at.line, offset: at.offset,
        includeExternalModuleExports: false, includeInsertTextCompletions: true,
      });
      const entries = (info && info.entries) || [];
      return entries.map((entry) => {
        const item = new vscode.CompletionItem(entry.name);
        item.sortText = entry.sortText;
        item.detail = entry.kind;
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
        if (!vscode.workspace.getConfiguration("twSugarcube").get("passageLinks", true)) return [];
        const projection = projectionOf(document);
        const out = [];
        // Every container member reference in the projection.
        const re = /(setup|State\s*\.\s*variables|State\s*\.\s*temporary|settings)\s*\.\s*([A-Za-z_$][\w$]*)/g;
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

  async function refresh(document) {
    if (!vscode.languages.match(SELECTOR, document)) return;
    if (!usable(document)) { diagnostics.delete(document.uri); return; }
    // Push the current buffer, then query — tsserver applies the two in order.
    pushLiveText(document, document.getText());
    const projection = projectionOf(document);
    const body = await request("semanticDiagnosticsSync", { file: projectedPath(document) });
    if (!Array.isArray(body)) { diagnostics.delete(document.uri); return; }
    const out = [];
    for (const d of body) {
      if (!d.start || !d.end || !d.text) continue;
      // A projection that tsserver hasn't adopted into the configured project
      // resolves `setup` to the empty shipped interface, making every member
      // look nonexistent. Those reports are always wrong here: the plugin keeps
      // the containers open with an index signature, so a genuine unknown member
      // is never an error in the first place.
      if (/does not exist on type 'SugarCube/.test(d.text)) continue;
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
      if (debounced.has(key)) { clearTimeout(debounced.get(key)); debounced.delete(key); }
      clearLiveText(doc); // plugin reverts to disk for this file
      projections.delete(key);
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
  ALLOWED_COMMANDS,
  // exposed for tests
  __test: { memberAtProjection, CONTAINERS, toTsPosition, offsetOfTsPosition, tsserverAvailable },
};
