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
  // create() registers its per-project config handler here. tsserver calls
  // onConfigurationChanged on the MODULE object (what init returns), NOT on the
  // language-service proxy — verified in tsserver's onPluginConfigurationChanged
  // — so the module forwards to create()'s scope, where refresh/liveText live.
  // A Set, not a single slot: a workspace can hold several configured projects,
  // and each needs the strict/typo/live push. Keying this off one create() meant
  // only the last-loaded project ever saw a configuration change.
  const configHandlers = new Set();

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

  // Per-project passage state, keyed by the project's current directory. These
  // were once module globals, which made a multi-project workspace pathological:
  // each project's getExternalFiles forces a rescan of ITS tree, and the shared
  // deletion pass then evicted every other project's projections as "missing",
  // so the projects perpetually invalidated each other. Scoping the cache, the
  // reload queue, the throttle, and the directory watcher per project ends that.
  //
  //   tweeFiles     norm(virtual .ts path) -> { content, mtime, segments, virtual, source, liveText? }
  //   pendingReload virtual paths whose projection changed, awaiting a ScriptInfo reload
  //   lastScan      throttle timestamp for this project's tree walk
  //   dirWatcher    this project's own .twee directory watcher
  //   configHandler this project's onConfigurationChanged handler (tracked so a
  //                 project reload replaces it instead of stacking duplicates)
  const projectStates = new Map();
  function projectStateFor(dir) {
    const key = norm(dir);
    let ps = projectStates.get(key);
    if (!ps) {
      ps = {
        dir: String(dir).replace(/\\/g, "/"),
        tweeFiles: new Map(),
        pendingReload: new Set(),
        lastScan: 0,
        dirWatcher: null,
        configHandler: null,
        // Item 10: getExternalFiles runs on every graph update and used to force
        // a full synchronous tree walk each time. Once this project's directory
        // watcher is live (`watching`), the cache stays current on its own, so
        // getExternalFiles can trust it unless a watcher event has flagged a twee
        // change (`dirty`). Starts dirty (and unwatched), so the initial load and
        // any host without watchDirectory still walk.
        dirty: true,
        watching: false,
      };
      projectStates.set(key, ps);
    }
    return ps;
  }
  // The patched serverHost serves any project's projection, so a lookup by path
  // has to cross project boundaries. Paths are absolute, so the first hit wins.
  function findTweeEntry(normPath) {
    for (const ps of projectStates.values()) {
      const entry = ps.tweeFiles.get(normPath);
      if (entry) return entry;
    }
    return null;
  }

  const tweeVirtualFor = (tweePath) => String(tweePath).replace(/\\/g, "/") + ".ts";

  function findTweeFiles(dir, out, depth) {
    if (depth > twee.MAX_SCAN_DEPTH) return out;
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
  // methods call this on every keystroke. The timestamp lives per project (on
  // pstate.lastScan); the interval is shared.
  const RESCAN_INTERVAL_MS = 250;
  // With the directory watcher live, adds/renames/deletes and live-buffer
  // pushes all flag `dirty` — but an in-place EDIT of a .twee on disk fires no
  // directory event (watchers deliver name events only; measured against
  // tsserver's own log), so the walk cannot be skipped outright. It runs at
  // this relaxed cadence instead: external edits are picked up within ~2s while
  // steady-state typing does 8x fewer synchronous walks on tsserver's thread.
  const WATCHED_RESCAN_INTERVAL_MS = 2000;

  // Unsaved editor content, keyed by normalized virtual (.ts) path ->
  // { virtual, source, text } (original-case paths plus the raw twee text).
  // The plugin runs inside tsserver and cannot see VS Code's dirty buffers, so
  // the extension pushes the live text through configurePlugin. While an entry
  // exists it overrides what's on disk, so passage intelligence reflects the
  // buffer without a save. Cleared when the document closes (back to disk).
  // Kept module-global — keyed by absolute path, so it is unambiguous across
  // projects and whichever project owns the file reads it during its scan. The
  // original-case paths are kept so an override whose disk file has vanished
  // (branch switch, atomic-rename save) can still be served — see the
  // live-preserve pass in syncTweeVirtuals.
  const liveText = new Map();

  function projectInto(tweeFiles, key, virtual, source, text, mtime) {
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

  // Walk one project's tree and refresh its projections. The pending-reload
  // queue has to outlive a single scan: getExternalFiles is called on EVERY
  // graph update and forces a rescan, so it would otherwise detect the change,
  // update the cache, and drop the news on the floor — leaving the
  // language-service path to conclude nothing had changed.
  function syncTweeVirtuals(pstate, options) {
    const { dir, tweeFiles, pendingReload } = pstate;
    const force = !!(options && options.force);
    const cached = () => ({ paths: [...tweeFiles.values()].map((e) => e.virtual), changed: [] });
    if (!force) {
      // Item 10, extended to the language-service path: while the directory
      // watcher is live and nothing has flagged `dirty`, walk at the relaxed
      // cadence — the watcher catches structural changes and live pushes flag
      // edits, leaving only external in-place edits for the walk to find.
      const interval = pstate.watching && !pstate.dirty
        ? WATCHED_RESCAN_INTERVAL_MS : RESCAN_INTERVAL_MS;
      if (Date.now() - pstate.lastScan < interval) return cached();
    }
    pstate.lastScan = Date.now();
    const paths = [];
    const changed = [];
    for (const file of findTweeFiles(dir, [], 0)) {
      const virtual = tweeVirtualFor(file);
      const key = norm(virtual);
      let mtime = 0;
      try { mtime = fsMod.statSync(file).mtimeMs; } catch (e) { continue; }
      const source = String(file).replace(/\\/g, "/");
      const entry = tweeFiles.get(key);
      // A live override always wins over disk, and is re-projected whenever its
      // text changes (tracked by entry.liveText identity) rather than by mtime.
      const live = liveText.get(key);
      if (live !== undefined) {
        if (!entry || entry.liveText !== live.text) {
          changed.push(virtual);
          pendingReload.add(virtual);
          projectInto(tweeFiles, key, virtual, source, live.text, mtime);
          tweeFiles.get(key).liveText = live.text;
        }
      } else if (!entry || entry.mtime !== mtime || entry.liveText !== undefined) {
        // No override (or one was just cleared): (re)project from disk.
        let text = "";
        try { text = fsMod.readFileSync(file, "utf8"); } catch (e) { continue; }
        changed.push(virtual);
        pendingReload.add(virtual);
        projectInto(tweeFiles, key, virtual, source, text, mtime);
      }
      paths.push(virtual);
    }
    // A live override whose disk file the walk did NOT find (deleted by a
    // branch switch, or mid-flight in an atomic-rename save) is still an open
    // editor buffer — the invariant is that live text wins over disk, so keep
    // serving it rather than letting the eviction pass below kill its
    // IntelliSense while the document is open.
    const onDisk = new Set(paths.map(norm));
    const root = norm(dir).replace(/\/+$/, "") + "/";
    for (const [key, live] of liveText) {
      if (onDisk.has(key) || !key.startsWith(root)) continue;
      const entry = tweeFiles.get(key);
      if (!entry || entry.liveText !== live.text) {
        changed.push(live.virtual);
        pendingReload.add(live.virtual);
        projectInto(tweeFiles, key, live.virtual, live.source, live.text, 0);
        tweeFiles.get(key).liveText = live.text;
      }
      paths.push(live.virtual);
    }
    // A .twee that was deleted must stop being served. tweeFiles holds only this
    // project's own walk, so "not in paths" means gone from this project — a scan
    // can no longer evict another project's projections.
    const seen = new Set(paths.map(norm));
    for (const key of [...tweeFiles.keys()]) {
      if (!seen.has(key)) {
        changed.push(tweeFiles.get(key).virtual);
        pendingReload.add(tweeFiles.get(key).virtual);
        tweeFiles.delete(key);
      }
    }
    // The cache now reflects this walk; only a new watcher event or live push
    // should force another one. (Meaningless without a watcher — the throttle
    // governs then — but harmless.)
    pstate.dirty = false;
    return { paths, changed };
  }

  const { interfaceFor } = analyzer;

  // `checker` only powers alias resolution (`const sv = State.variables`), so
  // both walks below degrade to the plain syntactic match without one. The
  // position test comes first in both: it rules out all but one node, and
  // resolving an alias costs a symbol lookup.
  function memberAt(sourceFile, position, checker) {
    let found = null;
    const visit = (node) => {
      if (found) return;
      if (ts.isPropertyAccessExpression(node) &&
          position >= node.name.getStart(sourceFile) && position <= node.name.getEnd()) {
        const iface = interfaceFor(node.expression, checker);
        if (iface) {
          found = { iface, name: node.name.text, node: node.name };
          return;
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return found;
  }

  function containerBeforeDot(sourceFile, position, checker) {
    let hit = null;
    const visit = (node) => {
      if (hit) return;
      if (ts.isPropertyAccessExpression(node) &&
          position >= node.expression.getEnd() && position <= node.getEnd()) {
        const iface = interfaceFor(node.expression, checker);
        if (iface) { hit = iface; return; }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return hit;
  }

  // A passage's prose says `You have $player.` and a passage's macro says
  // `<<print $player.>>`. Both end in a dot, and only one of them is a member
  // access — so the projector emits the dot ONLY inside a macro, where it is
  // unambiguously code. Emitting it in prose would turn every sentence that
  // ends on a variable into an "Identifier expected" parse error on text the
  // author wrote correctly.
  //
  // That leaves the editor with no dot to complete at the instant `.` is
  // pressed in prose. The cursor is the missing information: the extension
  // knows the author just typed a dot, so it asks at the END of the projected
  // expression with `triggerCharacter: "."`, and this fills in the members
  // TypeScript would have offered had the dot been there. Nothing is guessed —
  // the type comes from the checker, exactly as it would one keystroke later
  // (`$player.n` DOES project the dot, and completes natively).
  //
  // The outermost expression ending at the position, so `State.variables.player`
  // wins over the `player` identifier inside it — both end at the same offset,
  // and the identifier alone would complete against the wrong type.
  function expressionEndingAt(sourceFile, position) {
    let found = null;
    const visit = (node) => {
      if (found) return;
      if (node.getFullStart() > position || node.getEnd() < position) return;
      if (node.getEnd() === position && node !== sourceFile && ts.isExpression(node)) {
        found = node;
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return found;
  }

  // Property names that can follow a dot. A symbol whose name isn't a plain
  // identifier (`"two words"`, a private `#field`, an index signature) is not
  // reachable by the access the author is typing, so offering it would insert
  // something that doesn't compile.
  const IDENTIFIER_NAME = /^[A-Za-z_$][\w$]*$/;

  function memberCompletionsAt(program, sourceFile, position) {
    const node = expressionEndingAt(sourceFile, position);
    if (!node) return null;
    const checker = program.getTypeChecker();
    let type;
    try { type = checker.getTypeAtLocation(node); } catch (e) { return null; }
    if (!type) return null;
    // The apparent type, so a `string` member offers `length`/`toUpperCase` and
    // a union offers what all its constituents share, rather than nothing.
    let props = [];
    try { props = checker.getPropertiesOfType(checker.getApparentType(type)) || []; } catch (e) { return null; }
    const entries = [];
    for (const symbol of props) {
      const name = symbol.getName();
      if (!IDENTIFIER_NAME.test(name)) continue;
      const isMethod = !!(symbol.flags & (ts.SymbolFlags.Method | ts.SymbolFlags.Function));
      entries.push({
        name,
        kind: isMethod ? ts.ScriptElementKind.memberFunctionElement : ts.ScriptElementKind.memberVariableElement,
        kindModifiers: "",
        sortText: "0",
      });
    }
    // No properties means we have nothing better than TypeScript's own answer
    // (the expression is `any`, or isn't an object at all) — say so, rather than
    // returning an empty list that suppresses whatever else would have shown.
    if (!entries.length) return null;
    return { isGlobalCompletion: false, isMemberCompletion: true, isNewIdentifierLocation: false, entries };
  }

  const readStrict = (config) => (!config || typeof config.strict !== "boolean" ? true : config.strict);
  // Opt-in, and meaningless without strict: closing a container is only safe
  // once members are actually declared from their assignments.
  const readTypos = (config) => !!(config && config.typoDetection === true);

  // Everything here is built for CONFIGURED projects (getExternalFiles roots,
  // per-directory state, the tsconfig-scoped tree walk). As a global plugin we
  // are also loaded into inferred projects — and an inferred project rooted at
  // the same directory as a configured one would SHARE its per-directory state:
  // the two create() calls evict each other's config handler and regenerate the
  // same augmentation from different programs in a permanent ping-pong. So
  // inferred/external projects are left untouched. (Unknown project kinds are
  // treated as configured, the status quo, rather than silently dropped.)
  function isConfiguredProject(project) {
    try {
      const kinds = ts.server && ts.server.ProjectKind;
      if (!kinds || project.projectKind === undefined) return true;
      return project.projectKind === kinds.Configured;
    } catch (e) { return true; }
  }

  function create(info) {
    const ls = info.languageService;
    if (!isConfiguredProject(info.project)) return ls;
    const dir = info.project.getCurrentDirectory();
    const virtualFile = virtualFor(dir);
    const state = stateFor(virtualFile);
    const pstate = projectStateFor(dir);
    const log = (message) => {
      try { info.project.projectService.logger.info(`[tw-sugarcube] ${message}`); } catch (e) { /* logging is best-effort */ }
    };
    // The per-project watcher and config handler close over THIS create()'s
    // info/languageService. tsserver gives plugins no dispose hook, so if the
    // project is torn down (workspace folder removed, config deleted) those
    // closures would keep operating on a dead project — each checks this and
    // deregisters itself instead.
    const projectClosed = () => {
      try { return typeof info.project.isClosed === "function" && info.project.isClosed(); }
      catch (e) { return false; }
    };

    // This project's projections, keyed the way the analyzer expects.
    const scan = (program, checker) => analyzer.scan(program, checker, virtualFile, pstate.tweeFiles);
    const generate = (program, strict, typos) =>
      analyzer.generate(program, virtualFile, strict, typos, pstate.tweeFiles);

    // Item 9: the checkerless scan (assignment sites, no types) is what
    // completions and go-to-definition need, and each request re-walked every
    // source file in the program. It only changes when the program does — a
    // projection edit rebuilds the program (invalidate -> updateGraph), so a new
    // Program object tracks every content change — so cache it by Program
    // identity. A WeakMap lets superseded programs be collected.
    const scanCacheByProgram = new WeakMap();
    const scanSites = (program) => {
      let cached = scanCacheByProgram.get(program);
      if (!cached) { cached = scan(program, null); scanCacheByProgram.set(program, cached); }
      return cached;
    };

    // Serve the generated file from memory. Never touches the workspace.
    if (!hostPatched) {
      hostPatched = true;
      const serverHost = info.serverHost;
      const served = (p) => { const key = norm(p); return states.get(key) || findTweeEntry(key); };
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
      syncTweeVirtuals(pstate);
      if (!pstate.pendingReload.size) return false;
      // Drain: a path stays pending until someone reloads its ScriptInfo, which
      // is only possible once tsserver has created one for it.
      const files = [...pstate.pendingReload];
      pstate.pendingReload.clear();
      // Content-only refresh: reload the ScriptInfos that already exist. A file
      // with no ScriptInfo yet (a newly created/renamed .twee) simply stays
      // pending — making it a program ROOT needs a project reload, which is a
      // structural operation the directory watcher performs, never from inside a
      // language-service call (that recurses through the proxy). See onTweeEvent.
      const missed = invalidate(files);
      for (const m of missed) pstate.pendingReload.add(m);
      const done = files.length - pstate.pendingReload.size;
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
        const next = generate(program, strict, typoDetection);
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
      const checker = program.getTypeChecker();
      return prior.filter((d) => {
        if (!PROPERTY_MISSING.has(d.code) || typeof d.start !== "number") return true;
        return !memberAt(sf, d.start, checker);
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

      // A dot the projection couldn't carry (see memberCompletionsAt). The tell
      // is a `.` trigger with no `.` in front of the position: the author typed
      // one, the projected text doesn't have one there, so TypeScript is
      // answering for the PREVIOUS dot instead — completing `player` against
      // `State.variables` when what was asked for is the members of `player`.
      // That answer is not merely incomplete, it is about the wrong expression,
      // so it is replaced rather than added to. Confined to passage
      // projections; in a real .ts file the dot is always where it looks.
      if (sf && options && options.triggerCharacter === "." &&
          sf.text.charAt(position - 1) !== "." &&
          findTweeEntry(norm(fileName))) {
        const synthesized = memberCompletionsAt(program, sf, position);
        if (synthesized) return synthesized;
      }

      const iface = sf && containerBeforeDot(sf, position, program.getTypeChecker());
      if (!iface) return prior;

      // Generated members complete natively; this only fills in for containers
      // left open-ended (dynamic assignment or permissive mode).
      const base = prior || { isGlobalCompletion: false, isMemberCompletion: true, isNewIdentifierLocation: false, entries: [] };
      const existing = new Set(base.entries.map((e) => e.name));
      const entry = scanSites(program).get(iface);
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
      const member = sf && memberAt(sf, position, program.getTypeChecker());
      if (!member) return ls.getDefinitionAndBoundSpan(fileName, position);

      const entry = scanSites(program).get(member.iface);
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

    // Registered in the module-level Set so onConfigurationChanged reaches every
    // project. The live-buffer override itself is applied once, at the module
    // level (the map is global); each project only needs to re-sync when the
    // pushed file lives in ITS tree, so the throttle bypass stays confined to the
    // owning project on a keystroke. A project reload re-runs create(), so the
    // previous handler is removed before the new one is added — no duplicates.
    const root = norm(pstate.dir).replace(/\/+$/, "") + "/";
    const configHandler = (config, changedLive) => {
      // A disposed project's handler must not keep driving a dead language
      // service; deregister on first sight so the Set doesn't accumulate one
      // handler per closed project over a long session.
      if (projectClosed()) {
        configHandlers.delete(configHandler);
        if (pstate.configHandler === configHandler) pstate.configHandler = null;
        // Drop the dead project's state entirely: its frozen tweeFiles would
        // otherwise shadow a live project's fresh projection in findTweeEntry
        // (first hit wins) and be retained for the rest of the session.
        if (projectStates.get(norm(dir)) === pstate) projectStates.delete(norm(dir));
        return;
      }
      // changedLive holds the normalized virtual paths whose override was set,
      // updated, or cleared by this payload (null when the payload had none).
      if (changedLive && changedLive.some((key) => key.startsWith(root))) {
        pstate.lastScan = 0; // a live edit must bypass the rescan throttle
        pstate.dirty = true; // ...and the watcher gate — this change isn't on disk
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
    if (pstate.configHandler) configHandlers.delete(pstate.configHandler);
    pstate.configHandler = configHandler;
    configHandlers.add(configHandler);

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
    // One watcher per project (stored on pstate) — a workspace with several
    // configured projects needs each tree watched, not just the first to load.
    if (!pstate.dirWatcher && typeof info.serverHost.watchDirectory === "function") {
      // The set of registered projection paths, so a filesystem event can be
      // classified as structural (a .twee added or removed → the project's root
      // files must be rebuilt) or content-only (an existing .twee edited → just
      // reload its ScriptInfo).
      const knownPaths = () => new Set([...pstate.tweeFiles.keys()]);
      let pending = null;
      const onTweeEvent = () => {
        // Project torn down since the watcher attached: stop watching and reset
        // the per-project flags so a future create() for this directory installs
        // a fresh watcher instead of trusting this dead one.
        if (projectClosed()) {
          try { if (pstate.dirWatcher) pstate.dirWatcher.close(); } catch (e) { /* already gone */ }
          pstate.dirWatcher = null;
          pstate.watching = false;
          pstate.dirty = true;
          // Same as the config handler's close path: a dead project's frozen
          // projections must not shadow a live project's or leak for the session.
          if (projectStates.get(norm(dir)) === pstate) projectStates.delete(norm(dir));
          return;
        }
        pstate.lastScan = 0; // a real filesystem event bypasses the throttle
        const before = knownPaths();
        // The forced walk also clears `dirty`, so a getExternalFiles triggered
        // by the reload below can trust the cache (item 10) rather than walking
        // the tree again.
        syncTweeVirtuals(pstate, { force: true });
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
        // A path with no extension is (almost always) a DIRECTORY event —
        // renaming or deleting a folder of passages fires only the folder's
        // path, and filtering it out left every .twee underneath stuck in
        // pendingReload with no ScriptInfo (the structural reload never ran).
        const maybeDirectory = !pathMod.extname(changedPath);
        if (!twee.isTweeFile(changedPath) && !maybeDirectory) return;
        // A twee file (or a folder that may hold them) changed: the next
        // getExternalFiles must re-walk (item 10).
        pstate.dirty = true;
        // Debounce: a rename fires delete+create; an editor save can fire twice.
        if (pending) info.serverHost.clearTimeout(pending);
        pending = info.serverHost.setTimeout(() => { pending = null; onTweeEvent(); }, 150);
      };
      try {
        pstate.dirWatcher = info.serverHost.watchDirectory(
          dir, onChange, /*recursive*/ true, {}
        );
        pstate.watching = true; // getExternalFiles may now trust the cache
        log("watching the project for .twee changes");
      } catch (e) {
        // No watcher: getExternalFiles keeps force-walking (pstate.watching stays
        // false), so correctness never depends on a watcher that failed to attach.
        log(`could not watch the project directory: ${e && e.message}`);
      }
    }

    return proxy;
  }

  return {
    create,
    // tsserver dispatches configurePlugin here, on the module object — once for
    // the whole plugin, not per project.
    onConfigurationChanged(config) {
      // The live-buffer overrides are global (keyed by absolute path), so apply
      // them once here, before any handler runs — each project's handler then
      // re-syncs only if a changed file is in its tree. `liveDocs` is the FULL
      // set of live buffers ({ tweePath: text, ... }): present keys set or
      // update overrides, absent keys clear them (document closed, or state
      // replayed after a tsserver restart). A payload without the field (an
      // old-style or settings-only send) leaves the overrides untouched.
      const docs = config && config.liveDocs;
      let changedLive = null;
      if (docs && typeof docs === "object" && !Array.isArray(docs)) {
        changedLive = [];
        const next = new Map();
        for (const p of Object.keys(docs)) {
          if (typeof docs[p] !== "string") continue;
          const source = String(p).replace(/\\/g, "/");
          const isTwee = twee.isTweeFile(source);
          const virtual = isTwee ? source + ".ts" : source;
          const key = norm(virtual);
          next.set(key, { virtual, source: isTwee ? source : source.replace(/\.ts$/i, ""), text: docs[p] });
          const prev = liveText.get(key);
          if (!prev || prev.text !== docs[p]) changedLive.push(key);
        }
        for (const key of liveText.keys()) if (!next.has(key)) changedLive.push(key);
        liveText.clear();
        for (const [k, v] of next) liveText.set(k, v);
      }
      // strict / typoDetection apply to every configured project.
      for (const handler of configHandlers) handler(config, changedLive);
    },
    getExternalFiles(project) {
      if (!isConfiguredProject(project)) return [];
      const dir = project.getCurrentDirectory();
      const virtualFile = virtualFor(dir);
      stateFor(virtualFile);
      const ps = projectStateFor(dir);
      // Item 10: this runs on EVERY graph update. Once the directory watcher is
      // live it keeps the cache current, so unless a watcher event flagged a twee
      // change (`dirty`) the cached path set is already correct — return it
      // without a synchronous tree walk. Without a watcher, or when dirty, force
      // a fresh walk (and clear the flag).
      if (ps.watching && !ps.dirty) {
        return [virtualFile].concat([...ps.tweeFiles.values()].map((e) => e.virtual));
      }
      return [virtualFile].concat(syncTweeVirtuals(ps, { force: true }).paths);
    },
  };
}

module.exports = init;
