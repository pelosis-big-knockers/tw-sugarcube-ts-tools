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
      } else if (/\.(twee|tw)$/i.test(entry.name)) {
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
      const cached = tweeFiles.get(key);
      if (!cached || cached.mtime !== mtime) {
        changed.push(virtual);
        pendingReload.add(virtual);
        let text = "";
        try { text = fsMod.readFileSync(file, "utf8"); } catch (e) { continue; }
        let content = "";
        let segments = [];
        // A malformed passage must never take down the language service.
        try {
          const projected = twee.project(text);
          content = projected.ts;
          segments = projected.segments;
        } catch (e) { content = ""; segments = []; }
        tweeFiles.set(key, {
          content, mtime, segments, virtual,
          source: String(file).replace(/\\/g, "/"),
        });
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
    function syncPassages() {
      syncTweeVirtuals(info.project.getCurrentDirectory());
      if (!pendingReload.size) return false;
      // Drain: a path stays pending until someone reloads its ScriptInfo, which
      // is only possible once tsserver has created one for it.
      const files = [...pendingReload];
      pendingReload.clear();
      for (const missed of invalidate(files)) pendingReload.add(missed);
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

    proxy.onConfigurationChanged = (config) => {
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

    return proxy;
  }

  return {
    create,
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
