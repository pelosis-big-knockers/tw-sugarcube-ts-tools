// TypeScript language-service plugin for SugarCube intelligence.
//
// SugarCube's author-facing containers are populated by plain assignment —
// `setup.foo = ...`, `State.variables.hp = ...`, `settings.volume = ...` — which
// TypeScript can't see, because the corresponding interfaces ship empty.
//
// This plugin recovers each member's type from its assignment and feeds a
// generated module augmentation into the project, so TypeScript types the members
// natively: real hover types, parameter/arity checking, return types, and typo
// detection. Go-to-definition is redirected to the originating assignment so
// ctrl+click lands on your code rather than the generated declaration.
//
// Injection mechanism (this is load-bearing — see test/tsserver-smoke.mjs):
//   * `getExternalFiles` adds the generated file to the project, which is what
//     makes tsserver create a real ScriptInfo for it. Adding a name to the host's
//     getScriptFileNames() instead makes ProjectService.setDocument throw
//     "Debug Failure" and crashes the language service.
//   * The content is served from memory by patching `info.serverHost`, so nothing
//     is ever written to the user's workspace.
//   * Content is generated eagerly in create(), because the file is read before
//     the first language-service call. Generating lazily leaves it empty at that
//     read, which drops the augmentation entirely and reports every member as
//     nonexistent (the 0.4.1 bug).
//   * Regeneration is published by invalidating the ScriptInfo and marking the
//     project dirty, which is the ONLY delivery mechanism. tsserver never fires
//     a watcher for this path on its own — there is no file to observe — so a
//     captured watchFile callback added nothing but a race against other
//     global plugins. Measured on TS 5.9 and 6.0.3; see test/tsserver-smoke.mjs.
function init(modules) {
  const ts = modules.typescript;

  const PROPERTY_MISSING = new Set([2339, 2551, 2552]);
  const ALL_INTERFACES = ["SugarCubeSetupObject", "SugarCubeStoryVariables", "SugarCubeTemporaryVariables", "SugarCubeSettingVariables"];

  const norm = (p) => String(p).replace(/\\/g, "/").toLowerCase();
  const virtualFor = (dir) => String(dir).replace(/\\/g, "/").replace(/\/+$/, "") + "/__sugarcube-generated__.d.ts";

  // Per-project state, keyed by the normalized virtual path, so one patched
  // serverHost can serve several projects.
  const states = new Map();
  const stateFor = (virtualFile) => {
    const key = norm(virtualFile);
    if (!states.has(key)) states.set(key, { content: "" });
    return states.get(key);
  };
  let hostPatched = false;
  let dirWatcher = null;
  // create() registers its per-project config handler here. tsserver calls
  // onConfigurationChanged on the MODULE object (what init returns), NOT on the
  // language-service proxy — verified in tsserver's onPluginConfigurationChanged
  // — so the module must forward to create()'s scope, where refresh/liveText live.
  let activeConfigHandler = null;

  // ---- passages -----------------------------------------------------------
  // Each .twee file gets a virtual .ts sibling holding its projected passage
  // code. Registering it through getExternalFiles puts it in the CONFIGURED
  // project, so passage code sees the generated augmentation and the story's
  // own .ts sources — measured: quickinfo, diagnostics and go-to-definition all
  // resolve for these files, and tsserver answers even when they are not open.
  //
  // The editor owns content for open documents (the extension pushes the
  // projection of the live buffer); we project from disk so closed files still
  // participate.
  const fsMod = require("fs");
  const pathMod = require("path");
  const twee = require("./twee.js");
  // Shared with bin/lint.js so the CLI and the editor cannot drift apart.
  // It takes `ts` as a parameter because the plugin must use the TypeScript
  // instance tsserver injected, not one it resolves itself.
  const { createAnalyzer } = require("./analyzer.js");
  const analyzer = createAnalyzer(ts);
  const tweeFiles = new Map(); // normalized virtual path -> { content, mtime }

  const tweeVirtualFor = (tweePath) => String(tweePath).replace(/\\/g, "/") + ".ts";

  function findTweeFiles(dir, out, depth) {
    if (depth > 8) return out;
    let entries = [];
    try { entries = fsMod.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
    for (const entry of entries) {
      const full = pathMod.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name[0] === ".") continue;
        findTweeFiles(full, out, depth + 1);
      } else if (twee.isTweeFile(entry.name)) {
        out.push(full);
      }
    }
    return out;
  }

  // Re-projecting walks the workspace, so it is throttled: language-service
  // methods call this on every keystroke.
  const RESCAN_INTERVAL_MS = 250;
  let lastScan = 0;

  // Paths whose projection changed and which tsserver has not re-read yet.
  //
  // This has to outlive a single scan. `getExternalFiles` is called on EVERY
  // graph update and does a forced rescan, so it would otherwise detect the
  // change, update the cache, and drop the news on the floor — leaving the
  // language-service path to conclude nothing had changed. The set is drained
  // by whoever is in a position to act on it.
  const pendingReload = new Set();

  // Unsaved editor content, keyed by normalized twee path -> raw twee text.
  // The plugin runs inside tsserver and cannot see VS Code's dirty buffers, so
  // the extension pushes the live text through configurePlugin. While an entry
  // exists, it overrides what's on disk, so passage intelligence reflects the
  // buffer without a save. Cleared when the document closes (back to disk).
  const liveText = new Map();

  function projectInto(key, virtual, source, text, mtime) {
    let content = "";
    let segments = [];
    // A malformed passage must never take down the language service.
    try {
      const projected = twee.project(text);
      content = projected.ts;
      segments = projected.segments;
    } catch (e) { content = ""; segments = []; }
    tweeFiles.set(key, { content, mtime, segments, virtual, source });
  }

  function syncTweeVirtuals(dir, options) {
    const force = !!(options && options.force);
    if (!force && Date.now() - lastScan < RESCAN_INTERVAL_MS) {
      return { paths: [...tweeFiles.keys()].map((k) => tweeFiles.get(k).virtual), changed: [] };
    }
    lastScan = Date.now();
    const paths = [];
    const changed = [];
    for (const file of findTweeFiles(dir, [], 0)) {
      const virtual = tweeVirtualFor(file);
      const key = norm(virtual);
      let mtime = 0;
      try { mtime = fsMod.statSync(file).mtimeMs; } catch (e) { continue; }
      const source = String(file).replace(/\\/g, "/");
      const cached = tweeFiles.get(key);
      // A live override always wins over disk, and is re-projected whenever its
      // text changes (tracked by cached.liveText identity) rather than by mtime.
      const live = liveText.get(key);
      if (live !== undefined) {
        if (!cached || cached.liveText !== live) {
          changed.push(virtual);
          pendingReload.add(virtual);
          projectInto(key, virtual, source, live, mtime);
          tweeFiles.get(key).liveText = live;
        }
      } else if (!cached || cached.mtime !== mtime || cached.liveText !== undefined) {
        // No override (or one was just cleared): (re)project from disk.
        let text = "";
        try { text = fsMod.readFileSync(file, "utf8"); } catch (e) { continue; }
        changed.push(virtual);
        pendingReload.add(virtual);
        projectInto(key, virtual, source, text, mtime);
      }
      paths.push(virtual);
    }
    // A .twee that was deleted must stop being served.
    const live = new Set(paths.map(norm));
    for (const key of [...tweeFiles.keys()]) {
      if (!live.has(key)) {
        changed.push(tweeFiles.get(key).virtual);
        pendingReload.add(tweeFiles.get(key).virtual);
        tweeFiles.delete(key);
      }
    }
    return { paths, changed };
  }

  const { interfaceFor } = analyzer;
  // Passage projections keyed the way the analyzer expects.
  const scan = (program, checker, skipFile) => analyzer.scan(program, checker, skipFile, tweeFiles);
  const generate = (program, skipFile, strict, typos) =>
    analyzer.generate(program, skipFile, strict, typos, tweeFiles);

  function memberAt(sourceFile, position) {
    let found = null;
    const visit = (node) => {
      if (found) return;
      if (ts.isPropertyAccessExpression(node)) {
        const iface = interfaceFor(node.expression);
        if (iface && position >= node.name.getStart(sourceFile) && position <= node.name.getEnd()) {
          found = { iface, name: node.name.text, node: node.name };
          return;
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return found;
  }

  function containerBeforeDot(sourceFile, position) {
    let hit = null;
    const visit = (node) => {
      if (hit) return;
      if (ts.isPropertyAccessExpression(node)) {
        const iface = interfaceFor(node.expression);
        if (iface && position >= node.expression.getEnd() && position <= node.getEnd()) { hit = iface; return; }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return hit;
  }

  const readStrict = (config) => (!config || typeof config.strict !== "boolean" ? true : config.strict);
  // Opt-in, and meaningless without strict: closing a container is only safe
  // once members are actually declared from their assignments.
  const readTypos = (config) => !!(config && config.typoDetection === true);

  function create(info) {
    const ls = info.languageService;
    const virtualFile = virtualFor(info.project.getCurrentDirectory());
    const state = stateFor(virtualFile);
    const log = (message) => {
      try { info.project.projectService.logger.info(`[tw-sugarcube] ${message}`); } catch (e) { /* logging is best-effort */ }
    };

    // Serve the generated file from memory. Never touches the workspace.
    if (!hostPatched) {
      hostPatched = true;
      const serverHost = info.serverHost;
      const served = (p) => states.get(norm(p)) || tweeFiles.get(norm(p));
      const origRead = serverHost.readFile.bind(serverHost);
      const origExists = serverHost.fileExists.bind(serverHost);
      serverHost.readFile = (p, encoding) => { const s = served(p); return s ? s.content : origRead(p, encoding); };
      serverHost.fileExists = (p) => (served(p) ? true : origExists(p));
      if (serverHost.getFileSize) {
        const origSize = serverHost.getFileSize.bind(serverHost);
        serverHost.getFileSize = (p) => { const s = served(p); return s ? s.content.length : origSize(p); };
      }
      if (serverHost.watchFile) {
        // The generated file has no disk presence, so hand tsserver an inert
        // watcher rather than letting it fs-watch a path that doesn't exist.
        // We deliberately do NOT keep the callback: measurement showed tsserver
        // never invokes it on its own (0 spontaneous fires across TS 5.9 and
        // 6.0.3), and that the watcher isn't even registered until after
        // create() returns. Using it as a delivery path meant depending on
        // winning a patch-ordering race against other global plugins for a
        // mechanism that adds nothing over invalidate(). That dependency was
        // the 0.4.1 bug. See test/tsserver-smoke.mjs.
        const origWatch = serverHost.watchFile.bind(serverHost);
        serverHost.watchFile = (p, callback, interval, options) =>
          served(p) ? { close() {} } : origWatch(p, callback, interval, options);
      }
      log("serverHost patched");
    }

    let strict = readStrict(info.config);
    let typoDetection = readTypos(info.config);
    let lastProgram = null;
    let refreshing = false;
    let generationOk = false;

    // The sole delivery mechanism: ask tsserver to re-read the given files
    // (served from memory) and rebuild the project graph.
    function invalidate(files) {
      const missed = [];
      try {
        const service = info.project.projectService;
        for (const file of files || [virtualFile]) {
          const scriptInfo = service && service.getScriptInfo && service.getScriptInfo(file);
          // No ScriptInfo yet — tsserver creates one only when the path first
          // appears in getExternalFiles. Report it so the caller can retry
          // rather than silently dropping the update.
          if (!scriptInfo) { missed.push(file); continue; }
          if (typeof scriptInfo.reloadFromFile === "function") scriptInfo.reloadFromFile();
        }
        if (typeof info.project.markAsDirty === "function") info.project.markAsDirty();
        // markAsDirty only flags the project; the graph is rebuilt lazily. For a
        // real source file that's fine, because whatever changed it also woke
        // tsserver up. A passage projection changes only in our memory, so
        // nothing else prompts the rebuild — force it here or the new content is
        // never read.
        if (typeof info.project.updateGraph === "function") info.project.updateGraph();
      } catch (e) {
        log(`invalidate failed: ${e && e.message}`);
      }
      return missed;
    }

    // tsserver has no reason to watch .twee files — they aren't TypeScript, and
    // nothing it owns imports them — so editing one never updates the project
    // graph and getExternalFiles is never called again. Without this, passage
    // projections stay frozen at whatever they were when the project loaded:
    // a newly added `<<set $enemyName to "Goblin">>` is invisible, and a hover
    // past the end of the stale projection fails outright.
    // Re-concat getExternalFiles into the project's root files, which is what
    // turns a newly created/renamed .twee's projection into a program root.
    // Only a config reload does this; nothing lighter reaches the root set.
    function reloadProjectRoots() {
      const svc = info.project.projectService;
      if (svc && typeof svc.reloadConfiguredProject === "function") {
        try {
          // The signature has varied across versions; the two-arg form is current.
          svc.reloadConfiguredProject(info.project, "tw-sugarcube: passage file set changed");
          return true;
        } catch (e1) {
          try { svc.reloadConfiguredProject(info.project); return true; }
          catch (e2) { log(`reloadConfiguredProject failed: ${e2 && e2.message}`); }
        }
      }
      return false;
    }

    // reloadConfiguredProject rebuilds the project, which re-enters our proxy's
    // language-service methods → refresh() → syncPassages() → reload again,
    // recursing until the stack blows. syncPassages runs before refresh()'s own
    // `refreshing` guard is set, so it needs its own re-entrancy guard.
    let syncing = false;
    function syncPassages() {
      if (syncing) return false;
      syncing = true;
      try {
        return syncPassagesInner();
      } finally {
        syncing = false;
      }
    }

    function syncPassagesInner() {
      syncTweeVirtuals(info.project.getCurrentDirectory());
      if (!pendingReload.size) return false;
      // Drain: a path stays pending until someone reloads its ScriptInfo, which
      // is only possible once tsserver has created one for it.
      const files = [...pendingReload];
      pendingReload.clear();
      // Content-only refresh: reload the ScriptInfos that already exist. A file
      // with no ScriptInfo yet (a newly created/renamed .twee) simply stays
      // pending — making it a program ROOT needs a project reload, which is a
      // structural operation the directory watcher performs, never from inside a
      // language-service call (that recurses through the proxy). See onTweeEvent.
      const missed = invalidate(files);
      for (const m of missed) pendingReload.add(m);
      const done = files.length - pendingReload.size;
      if (done > 0) log(`re-projected ${done} passage file(s)`);
      return done > 0;
    }

    function refresh() {
      if (refreshing) return;
      // Pick up passage edits BEFORE asking for the program, so the request that
      // triggered this refresh sees the new content rather than the next one.
      syncPassages();
      const program = ls.getProgram();
      if (!program || program === lastProgram) return;
      refreshing = true;
      try {
        lastProgram = program;
        const next = generate(program, virtualFile, strict, typoDetection);
        if (next !== state.content) {
          state.content = next;
          invalidate();
          // Recovered types can depend on previously generated ones; re-check on
          // the next call so we settle at a fixed point.
          lastProgram = null;
        }
        generationOk = true;
      } catch (e) {
        generationOk = false;
        log(`generation failed: ${e && e.message}`);
      } finally {
        refreshing = false;
      }
    }

    const proxy = Object.create(null);
    for (const k of Object.keys(ls)) {
      const orig = ls[k];
      proxy[k] = (...args) => orig.apply(ls, args);
    }

    proxy.getSemanticDiagnostics = (fileName) => {
      refresh();
      const prior = ls.getSemanticDiagnostics(fileName);
      // With generation working the members are declared, so "does not exist" is a
      // real typo and must survive. Only fall back to suppressing if generation
      // failed, so a broken generator can't spam a project with errors.
      if (generationOk) return prior;
      const program = ls.getProgram();
      const sf = program && program.getSourceFile(fileName);
      if (!sf) return prior;
      return prior.filter((d) => {
        if (!PROPERTY_MISSING.has(d.code) || typeof d.start !== "number") return true;
        return !memberAt(sf, d.start);
      });
    };

    proxy.getQuickInfoAtPosition = (fileName, position) => {
      refresh();
      return ls.getQuickInfoAtPosition(fileName, position);
    };

    proxy.getCompletionsAtPosition = (fileName, position, options, settings) => {
      refresh();
      const prior = ls.getCompletionsAtPosition(fileName, position, options, settings);
      const program = ls.getProgram();
      const sf = program && program.getSourceFile(fileName);
      const iface = sf && containerBeforeDot(sf, position);
      if (!iface) return prior;

      // Generated members complete natively; this only fills in for containers
      // left open-ended (dynamic assignment or permissive mode).
      const base = prior || { isGlobalCompletion: false, isMemberCompletion: true, isNewIdentifierLocation: false, entries: [] };
      const existing = new Set(base.entries.map((e) => e.name));
      const entry = scan(program, null, virtualFile).get(iface);
      for (const name of entry ? entry.members.keys() : []) {
        if (existing.has(name)) continue;
        base.entries.push({ name, kind: ts.ScriptElementKind.memberVariableElement, kindModifiers: "", sortText: "0" });
      }
      return base;
    };

    proxy.getDefinitionAndBoundSpan = (fileName, position) => {
      refresh();
      const program = ls.getProgram();
      const sf = program && program.getSourceFile(fileName);
      const member = sf && memberAt(sf, position);
      if (!member) return ls.getDefinitionAndBoundSpan(fileName, position);

      const entry = scan(program, null, virtualFile).get(member.iface);
      const record = entry && entry.members.get(member.name);
      const sites = (record && record.sites) || [];
      if (sites.length === 0) return ls.getDefinitionAndBoundSpan(fileName, position);

      // Redirect away from the generated declaration to the real assignment(s).
      return {
        textSpan: { start: member.node.getStart(sf), length: member.node.getWidth(sf) },
        definitions: sites.map((s) => ({
          fileName: s.fileName, textSpan: { start: s.start, length: s.end - s.start },
          kind: ts.ScriptElementKind.memberVariableElement, name: member.name,
          containerName: member.iface, containerKind: ts.ScriptElementKind.variableElement,
        })),
      };
    };

    activeConfigHandler = (config) => {
      // Live passage buffers pushed from the extension (it can see unsaved text;
      // the plugin can't). `{ path, text }` sets an override; `text === null`
      // clears it (document closed) and reverts to disk.
      const live = config && config.liveDoc;
      if (live && typeof live.path === "string") {
        const key = norm(twee.isTweeFile(live.path) ? live.path + ".ts" : live.path);
        if (live.text === null || live.text === undefined) liveText.delete(key);
        else liveText.set(key, String(live.text));
        lastScan = 0; // a live edit must bypass the rescan throttle
        syncPassages();
      }

      const nextStrict = readStrict(config);
      const nextTypos = readTypos(config);
      if (nextStrict === strict && nextTypos === typoDetection) return;
      strict = nextStrict;
      typoDetection = nextTypos;
      lastProgram = null; // regenerate under the new mode
      refresh();
    };

    // Generate up front so the file already has content the first time tsserver
    // reads it. Waiting until the first language-service call means the file is
    // read empty and the content can only arrive via the watcher — which isn't
    // guaranteed to be ours when several plugins are loaded (that was the 0.4.1
    // bug: the watcher never fired and every member stayed unknown).
    refresh();
    log(`ready (${state.content.length} bytes generated, strict=${strict}, typoDetection=${typoDetection})`);

    // Watch the project for .twee files appearing, disappearing, or being
    // renamed. Editing an EXISTING passage is picked up by refresh() (a .ts
    // language-service call re-syncs from disk), but a brand-new or renamed
    // .twee never touches a .ts file, so without this its projection is never
    // registered and the editor gets "No Project" for it. tsserver won't watch
    // .twee itself — it's not TypeScript and nothing it owns imports it — so the
    // plugin watches on its own behalf.
    if (!dirWatcher && typeof info.serverHost.watchDirectory === "function") {
      // The set of registered projection paths, so a filesystem event can be
      // classified as structural (a .twee added or removed → the project's root
      // files must be rebuilt) or content-only (an existing .twee edited → just
      // reload its ScriptInfo).
      const knownPaths = () => new Set([...tweeFiles.keys()]);
      let pending = null;
      const onTweeEvent = () => {
        lastScan = 0; // a real filesystem event bypasses the throttle
        const before = knownPaths();
        syncTweeVirtuals(info.project.getCurrentDirectory(), { force: true });
        const after = knownPaths();
        const structural = before.size !== after.size ||
          [...after].some((p) => !before.has(p));
        if (structural) {
          // A new/renamed/deleted .twee changes which files exist. Only a config
          // reload re-concats getExternalFiles into the program's roots (a plain
          // markAsDirty rebuilds from the existing roots and never picks it up).
          // Safe here because we're in a watcher callback, outside any
          // language-service request. See reloadProjectRoots.
          reloadProjectRoots();
        }
        syncPassages(); // reload content of whatever now has a ScriptInfo
      };
      const onChange = (changedPath) => {
        if (!twee.isTweeFile(changedPath) && !/\.(twee|tw|twee2|tw2)\.ts$/i.test(changedPath)) return;
        // Debounce: a rename fires delete+create; an editor save can fire twice.
        if (pending) info.serverHost.clearTimeout(pending);
        pending = info.serverHost.setTimeout(() => { pending = null; onTweeEvent(); }, 150);
      };
      try {
        dirWatcher = info.serverHost.watchDirectory(
          info.project.getCurrentDirectory(), onChange, /*recursive*/ true, {}
        );
        log("watching the project for .twee changes");
      } catch (e) {
        log(`could not watch the project directory: ${e && e.message}`);
      }
    }

    return proxy;
  }

  return {
    create,
    // tsserver dispatches configurePlugin here, on the module object.
    onConfigurationChanged(config) {
      if (activeConfigHandler) activeConfigHandler(config);
    },
    getExternalFiles(project) {
      const virtualFile = virtualFor(project.getCurrentDirectory());
      stateFor(virtualFile);
      // force: the project is asking which files exist, so an up-to-date answer
      // matters more than the throttle.
      return [virtualFile].concat(
        syncTweeVirtuals(project.getCurrentDirectory(), { force: true }).paths
      );
    },
  };
}

module.exports = init;
