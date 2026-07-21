// Smoke test that drives a REAL tsserver with the plugin loaded as a global
// plugin — the same way VS Code loads it.
//
// This exists because a previous release shipped an injection mechanism that
// worked fine against a bare `ts.createLanguageService` but crashed the language
// service under tsserver ("Debug Failure" from ProjectService.setDocument,
// because injected files had no ScriptInfo). A hand-rolled LanguageService host
// does NOT represent tsserver. Anything touching file injection must be verified
// here before shipping.
import { spawn } from "child_process";
import { readFileSync, existsSync, writeFileSync, cpSync, rmSync } from "fs";
import { createRequire } from "module";
import path from "path";
import { fileURLToPath } from "url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.dirname(testDir);
const require = createRequire(import.meta.url);
// Positions inside projected passage files are computed from the REAL
// projection rather than hardcoded, so a layout change in the projector (e.g.
// scaffolding moving to its own line) doesn't silently invalidate them.
const { project: projectTwee } = require(path.join(repoRoot, "ts-plugin", "twee.js"));
const toPosix = (p) => p.split("\\").join("/");
const TSSERVER = toPosix(path.join(repoRoot, "node_modules", "typescript", "lib", "tsserver.js"));

// A real VS Code session loads several global plugins, and ours is not first.
// v0.4.1 shipped a bug that ONLY appears in that arrangement — our generated
// content reached the program solely via a watcher callback we captured, and
// with other plugins in the chain the capture wasn't ours, so every member came
// back "does not exist". A single-plugin harness cannot catch that class of bug,
// so every scenario below runs with decoys on both sides of us.
const DECOYS = ["decoy-plugin-before", "decoy-plugin-after"];
for (const name of DECOYS) {
  const dest = path.join(repoRoot, "node_modules", name);
  rmSync(dest, { recursive: true, force: true });
  cpSync(path.join(testDir, "decoy"), dest, { recursive: true });
}
const PLUGIN_CHAIN = [DECOYS[0], "tw-sugarcube-ts-plugin", DECOYS[1]].join(",");

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}${ok || !detail ? "" : `\n        ${detail}`}`);
};

function withServer(fixtureDir, run) {
  return new Promise(async (resolve) => {
    const proj = toPosix(fixtureDir);
    const logFile = toPosix(path.join(testDir, ".tsserver.log"));
    const srv = spawn(process.execPath, [
      TSSERVER,
      "--globalPlugins", PLUGIN_CHAIN,
      "--pluginProbeLocations", toPosix(repoRoot),
      "--logVerbosity", "verbose", "--logFile", logFile,
    ], { stdio: ["pipe", "pipe", "pipe"] });

    let seq = 0;
    const responses = [];
    let buf = "";
    srv.stdout.on("data", (d) => {
      buf += d.toString();
      while (true) {
        const m = buf.match(/Content-Length: (\d+)\r\n\r\n/);
        if (!m) break;
        const start = m.index + m[0].length;
        const len = parseInt(m[1]);
        if (buf.length < start + len) break;
        try { responses.push(JSON.parse(buf.slice(start, start + len))); } catch { /* partial */ }
        buf = buf.slice(start + len);
      }
    });

    const send = (command, args) =>
      srv.stdin.write(JSON.stringify({ seq: ++seq, type: "request", command, arguments: args }) + "\n");
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const lastOf = (command) => {
      const all = responses.filter((r) => r.command === command);
      return all[all.length - 1];
    };
    const diagnostics = () => (lastOf("semanticDiagnosticsSync")?.body ?? []).map((d) => d.text);

    await wait(900);
    await run({ proj, send, wait, responses, diagnostics, lastOf });
    srv.kill();
    await wait(250);

    const log = existsSync(logFile) ? readFileSync(logFile, "utf8") : "";
    // A failed REQUEST is not a crashed language service. Treating every
    // `success: false` as a crash meant any new check that legitimately errored
    // also reported a phantom "Debug Failure seen", pointing at the wrong bug.
    const crashed = responses.some((r) => r.message && /Debug Failure/i.test(r.message))
      || /Debug Failure/i.test(log);
    resolve({ crashed, log });
  });
}

// Locate a 1-based line/offset for the Nth occurrence of `needle`.
function positionOf(content, needle, occurrence = 1) {
  let index = -1;
  for (let i = 0; i < occurrence; i++) index = content.indexOf(needle, index + 1);
  const before = content.slice(0, index);
  const line = before.split("\n").length;
  const offset = index - (before.lastIndexOf("\n") + 1) + 1;
  return { line, offset };
}

async function main() {
  console.log("tsserver smoke test (real tsserver, plugin loaded as a global plugin)\n");

  // ---------- strict mode ----------
  const fixture = path.join(testDir, "fixture");
  const worldPath = path.join(fixture, "world.ts");
  const worldOriginal = readFileSync(worldPath, "utf8");
  const usePath = toPosix(path.join(fixture, "use.ts"));
  const useContent = readFileSync(path.join(fixture, "use.ts"), "utf8");

  console.log("strict mode:");
  const strictRun = await withServer(fixture, async ({ proj, send, wait, diagnostics, lastOf }) => {
    send("open", { file: usePath, projectRootPath: proj });
    send("open", { file: toPosix(worldPath), projectRootPath: proj });
    await wait(2600);

    send("semanticDiagnosticsSync", { file: usePath });
    await wait(1600);
    const diags = diagnostics();
    check("parameter type is checked", diags.some((d) => /not assignable to parameter of type 'number'/.test(d)), diags.join(" | "));
    // Regression guard: members are routinely created outside the TypeScript we
    // can see (`<<set $hp to 1>>` in a passage, Setting.addToggle, ...). Reading
    // one we never saw assigned must never be reported as nonexistent — that bug
    // shipped in 0.4.0 because every fixture assigned everything it read.
    check("reading a never-assigned member does not error",
      !diags.some((d) => /does not exist/.test(d)), diags.join(" | "));
    check("only the real error is reported", diags.length === 1, diags.join(" | "));

    // go-to-definition must land on the assignment, not the generated declaration
    const pos = positionOf(useContent, "attack", 1);
    send("definitionAndBoundSpan", { file: usePath, line: pos.line, offset: pos.offset + 1 });
    await wait(900);
    const def = lastOf("definitionAndBoundSpan")?.body?.definitions?.[0];
    check("go-to-definition redirects to the assignment",
      !!def && /world\.ts$/i.test(def.file) && !/__sugarcube-generated__/.test(def.file),
      def ? def.file : "(no definition)");

    // Hover must read the way the author writes it. Quoting every member in the
    // generated declaration made TypeScript echo `SugarCubeSetupObject["attack"]`
    // back on hover, even though nothing in the source uses bracket notation.
    send("quickinfo", { file: usePath, line: pos.line, offset: pos.offset + 1 });
    await wait(900);
    const hover = lastOf("quickinfo")?.body?.displayString ?? "";
    check("hover shows dot notation, not [\"...\"]", /\.attack\b/.test(hover) && !/\["attack"\]/.test(hover), hover || "(no quickinfo)");

    // live edit: make attack take a string, so the previous error must clear
    writeFileSync(worldPath, "setup.attack = (power: string): string => power;\nState.variables.hp = 100;\n");
    send("updateOpen", {
      changedFiles: [], closedFiles: [],
      openFiles: [{ file: toPosix(worldPath), fileContent: readFileSync(worldPath, "utf8"), projectRootPath: proj, scriptKindName: "TS" }],
    });
    await wait(1500);
    send("semanticDiagnosticsSync", { file: usePath });
    await wait(1600);
    const after = diagnostics();
    check("regenerates after a source edit", !after.some((d) => /not assignable to parameter of type 'number'/.test(d)), after.join(" | "));
  });
  writeFileSync(worldPath, worldOriginal); // restore fixture
  check("no language-service crash (strict)", !strictRun.crashed, "Debug Failure seen in responses or log");
  check("plugin loaded", /Loading .*tw-sugarcube-ts-plugin|Enabling plugin tw-sugarcube-ts-plugin/.test(strictRun.log), "plugin never loaded");
  check("nothing written to the workspace", !existsSync(path.join(fixture, "__sugarcube-generated__.d.ts")), "generated file leaked to disk");

  // The decoys must actually be in the chain, or every multi-plugin claim below
  // is vacuous.
  check("decoy plugins loaded around ours",
    DECOYS.every((name) => new RegExp(`\\[${name}\\] create`).test(strictRun.log)),
    "decoys never initialized — the multi-plugin checks prove nothing");

  // The 0.4.1 root cause: generation happened on the first language-service call,
  // i.e. AFTER tsserver had already read the virtual file as empty, leaving the
  // watcher as the only delivery path. Content must exist by the end of create().
  //
  // NOTE ON STRENGTH: this is a white-box check against our own log line, and it
  // is the ONLY check that catches the regression — removing the eager refresh()
  // leaves every behavioural check above still passing, because the stub it emits
  // is what suppresses the phantom errors, and member typing arrives later by a
  // separate path. Two distinct failure modes, one visible symptom. If this log
  // line ever goes away, the coverage goes with it.
  const ready = /\[tw-sugarcube\] ready \((\d+) bytes generated/.exec(strictRun.log);
  check("content is generated during create(), not on first request",
    !!ready && Number(ready[1]) > 0, ready ? `${ready[1]} bytes` : "no 'ready' line in the log");
  // Delivery must go through invalidate() only. A watcher callback is not a
  // usable delivery path here: tsserver never fires one for this path (no file
  // to observe) and it isn't registered until after create() returns, so relying
  // on it only reintroduced a race against other global plugins.
  check("does not rely on a captured watcher",
    !/captured watcher/.test(strictRun.log),
    "the watcher-capture path is back — delivery is ordering-dependent again");

  // ---------- dynamic assignment keeps its container open ----------
  console.log("\ndynamic-assignment fallback:");
  const dynFixture = path.join(testDir, "fixture-dynamic");
  const dynUse = toPosix(path.join(dynFixture, "use.ts"));
  const dynRun = await withServer(dynFixture, async ({ proj, send, wait, diagnostics }) => {
    send("open", { file: dynUse, projectRootPath: proj });
    await wait(2600);
    send("semanticDiagnosticsSync", { file: dynUse });
    await wait(1600);
    const diags = diagnostics();
    check("computed assignment leaves the container permissive", diags.length === 0, diags.join(" | "));
  });
  check("no language-service crash (dynamic)", !dynRun.crashed, "Debug Failure seen in responses or log");

  // ---------- passages (.twee) ----------
  // The plugin projects each .twee into a virtual .ts sibling and registers it
  // through getExternalFiles. What has to hold: the projection lands in the
  // CONFIGURED project (so it sees the generated augmentation and the story's
  // own sources), and tsserver answers for it even though it is never opened and
  // does not exist on disk.
  console.log("\npassages:");
  const tweeFixture = path.join(testDir, "fixture-twee");
  const tweeWorld = toPosix(path.join(tweeFixture, "world.ts"));
  const projected = toPosix(path.join(tweeFixture, "story.twee")) + ".ts";
  const tweeRun = await withServer(tweeFixture, async ({ proj, send, wait, diagnostics, lastOf }) => {
    send("open", { file: tweeWorld, projectRootPath: proj });
    await wait(2600);

    send("projectInfo", { file: projected, needFileNameList: false });
    await wait(900);
    const owner = lastOf("projectInfo")?.body?.configFileName ?? "";
    check("passage projection joins the configured project",
      /tsconfig\.json$/i.test(owner), owner || "(no project)");

    // `setup.attack` is defined in world.ts and typed via the augmentation, so
    // hovering it inside a passage must produce the real signature.
    const projTs = projectTwee(readFileSync(path.join(tweeFixture, "story.twee"), "utf8")).ts;
    const atAttack = positionOf(projTs, "attack(");
    send("quickinfo", { file: projected, line: atAttack.line, offset: atAttack.offset });
    await wait(900);
    const hover = lastOf("quickinfo")?.body?.displayString ?? "";
    check("passage code resolves setup members",
      /attack: \(power: number\) => number/.test(hover), hover || "(no quickinfo)");

    send("semanticDiagnosticsSync", { file: projected });
    await wait(1500);
    const diags = diagnostics();
    check("a wrong argument in a passage is reported",
      diags.some((d) => /not assignable to parameter of type 'number'/.test(d)), diags.join(" | "));
    // The rest of the fixture is valid passage code. A second diagnostic means
    // the projection invented something the author never wrote.
    check("valid passage code produces no errors", diags.length === 1, diags.join(" | "));

    // Go-to-definition from a passage must land on the author's assignment.
    send("definitionAndBoundSpan", { file: projected, line: atAttack.line, offset: atAttack.offset });
    await wait(900);
    const def = lastOf("definitionAndBoundSpan")?.body?.definitions?.[0];
    check("go-to-definition from a passage lands on the source",
      !!def && /world\.ts$/i.test(def.file), def ? def.file : "(no definition)");
  });
  check("no language-service crash (passages)", !tweeRun.crashed, "Debug Failure seen in responses or log");
  check("no projected file written to the workspace",
    !existsSync(path.join(tweeFixture, "story.twee.ts")), "projection leaked to disk");

  // ---------- a .twee CREATED after the project loaded ----------
  // A newly created (or renamed) .twee never touches a .ts file, so nothing
  // re-runs getExternalFiles — and even when it does, getExternalFiles is only
  // concatenated into the project's ROOT files on a config reload, so the new
  // projection isn't a program root. The plugin watches the directory and
  // reloads the project on a structural change. Without that, the editor gets
  // "No Project" for every freshly created passage file.
  console.log("\npassage file created after load:");
  const newFixture = path.join(testDir, "fixture-twee-new");
  const newWorld = toPosix(path.join(newFixture, "world.ts"));
  const createdTwee = path.join(newFixture, "created.twee");
  const createdProjected = toPosix(createdTwee) + ".ts";
  rmSync(createdTwee, { force: true }); // ensure it's absent at load
  const newRun = await withServer(newFixture, async ({ proj, send, wait, lastOf }) => {
    send("open", { file: newWorld, projectRootPath: proj });
    await wait(2600);

    // Create the passage AFTER the project is up — the user's scenario.
    writeFileSync(createdTwee, ":: Start\n<<run setup.attack(3)>>\n");
    await wait(1600); // watcher debounce (150ms) + project reload

    send("quickinfo", { file: createdProjected, line: 1, offset: 8 });
    await wait(900);
    const hover = lastOf("quickinfo")?.body?.displayString ?? "";
    check("a passage created after load is analyzed without a reload",
      /attack: \(power: number\) => number/.test(hover),
      hover || JSON.stringify(lastOf("quickinfo")?.message || "(no response)"));
  });
  rmSync(createdTwee, { force: true });
  check("no language-service crash (created passage)", !newRun.crashed, "Debug Failure seen");

  // ---------- live (unsaved) passage buffers ----------
  // tsserver only sees disk, and updateOpen is blocked by the request allowlist,
  // so the editor pushes the raw twee text through configurePlugin and the plugin
  // overrides disk with it. This is how passage intelligence tracks an unsaved
  // buffer. Disk stays valid throughout; we push an erroring version, a corrected
  // version, then clear the override and confirm it reverts to disk.
  console.log("\nlive (unsaved) passage buffer:");
  const liveFixture = path.join(testDir, "fixture-twee-live");
  const liveWorld = toPosix(path.join(liveFixture, "world.ts"));
  const liveTweePath = toPosix(path.join(liveFixture, "story.twee"));
  const liveProjected = liveTweePath + ".ts";
  const liveDiskBefore = readFileSync(path.join(liveFixture, "story.twee"), "utf8");
  // `liveDocs` is the FULL set of live buffers per payload (an absent key
  // clears that override) — so VS Code's replay of the last payload after a
  // tsserver restart restores every override, not just the most recent file's.
  const pushLive = (send, text) =>
    send("configurePlugin", { pluginName: "tw-sugarcube-ts-plugin", configuration: { strict: true, liveDocs: text === null ? {} : { [liveTweePath]: text } } });
  const liveRun = await withServer(liveFixture, async ({ proj, send, wait, diagnostics }) => {
    send("open", { file: liveWorld, projectRootPath: proj });
    await wait(2600);

    // Unsaved edit introducing a type error.
    pushLive(send, ':: Start\n<<run setup.attack("wrong")>>\n');
    await wait(1200);
    send("semanticDiagnosticsSync", { file: liveProjected });
    await wait(1400);
    check("an unsaved edit's error is reflected without a save",
      diagnostics().some((d) => /not assignable to parameter of type 'number'/.test(d)), diagnostics().join(" | "));

    // Corrected unsaved edit.
    pushLive(send, ":: Start\n<<run setup.attack(42)>>\n");
    await wait(1200);
    send("semanticDiagnosticsSync", { file: liveProjected });
    await wait(1400);
    check("correcting the unsaved buffer clears the error", diagnostics().length === 0, diagnostics().join(" | "));

    // Close: clear the override, revert to disk (which is valid).
    pushLive(send, null);
    await wait(1200);
    send("semanticDiagnosticsSync", { file: liveProjected });
    await wait(1400);
    check("clearing the override reverts to disk", diagnostics().length === 0, diagnostics().join(" | "));
  });
  check("no language-service crash (live buffer)", !liveRun.crashed, "Debug Failure seen");
  check("disk file untouched by live editing",
    readFileSync(path.join(liveFixture, "story.twee"), "utf8") === liveDiskBefore, "disk changed");

  // ---------- passage assignments as a type source ----------
  // `<<set $hp to 100>>` is how most story variables come into existence, so it
  // is the main source of their types. The fixture's .ts file only READS them.
  console.log("\npassage variables:");
  const varsFixture = path.join(testDir, "fixture-twee-vars");
  const varsWorld = toPosix(path.join(varsFixture, "world.ts"));
  const varsRun = await withServer(varsFixture, async ({ proj, send, wait, diagnostics, lastOf }) => {
    send("open", { file: varsWorld, projectRootPath: proj });
    await wait(2600);

    // Reading passage-created variables at their correct types must be clean,
    // and reading one nothing ever assigns must still not error.
    send("semanticDiagnosticsSync", { file: varsWorld });
    await wait(1600);
    const diags = diagnostics();
    check("correct use of passage variables is clean", diags.length === 0, diags.join(" | "));

    // THE load-bearing check. Without harvesting, `hp` is `any` via the index
    // signature and this assignment compiles — so a "clean file" check alone
    // proves nothing about whether the type was actually applied.
    const misuse = toPosix(path.join(varsFixture, "misuse.ts"));
    send("open", { file: misuse, projectRootPath: proj });
    await wait(1200);
    send("semanticDiagnosticsSync", { file: misuse });
    await wait(1600);
    const wrong = diagnostics();
    check("a passage-derived type is enforced, not just present",
      wrong.some((d) => /Type 'number' is not assignable to type 'string'/.test(d)),
      wrong.join(" | ") || "(no diagnostics — hp is still `any`)");

    send("quickinfo", { file: varsWorld, line: 3, offset: 43 });
    await wait(900);
    const hover = lastOf("quickinfo")?.body?.displayString ?? "";
    check("hover shows the passage-derived type", /hp: number/.test(hover), hover || "(no quickinfo)");

    // Go-to-definition must land in the .twee file, not the virtual projection.
    send("definitionAndBoundSpan", { file: varsWorld, line: 3, offset: 43 });
    await wait(900);
    const def = lastOf("definitionAndBoundSpan")?.body?.definitions?.[0];
    check("go-to-definition lands in the .twee source",
      !!def && /story\.twee$/i.test(def.file),
      def ? def.file : "(no definition)");
    check("the definition span is the author's text, not the projection",
      !!def && def.start.line === 5, def ? `line ${def.start.line}` : "(none)");
  });
  check("no language-service crash (passage variables)", !varsRun.crashed, "Debug Failure seen");

  // ---------- editing a passage after the project has loaded ----------
  // tsserver never watches .twee files, so nothing makes it call getExternalFiles
  // again after an edit. Without an explicit re-projection the declarations stay
  // frozen at project-load time: a newly added `<<set>>` is invisible, and a
  // query past the end of the stale projection errors outright.
  console.log("\npassage edits:");
  const editFixture = path.join(testDir, "fixture-twee-vars");
  const editTwee = path.join(editFixture, "story.twee");
  const editOriginal = readFileSync(editTwee, "utf8");
  const editWorld = toPosix(path.join(editFixture, "world.ts"));
  const editRun = await withServer(editFixture, async ({ proj, send, wait, diagnostics, lastOf }) => {
    send("open", { file: editWorld, projectRootPath: proj });
    await wait(2600);
    send("semanticDiagnosticsSync", { file: editWorld });
    await wait(1500);

    // Add a variable the project has never seen, exactly as an author would.
    writeFileSync(editTwee, editOriginal + '<<set $enemyName to "Goblin">>\nThe enemy is $enemyName.\n');
    await wait(1200);

    // A .ts file that reads the new variable at its passage-derived type.
    const reader = toPosix(path.join(editFixture, "reader.ts"));
    writeFileSync(reader.split("/").join(path.sep), "const enemy: string = State.variables.enemyName;\n");
    send("open", { file: reader, projectRootPath: proj });
    await wait(2000);
    send("semanticDiagnosticsSync", { file: reader });
    await wait(1600);
    const diags = diagnostics();
    check("a variable added by a passage edit is picked up", diags.length === 0, diags.join(" | "));

    send("quickinfo", { file: reader, line: 1, offset: 40 });
    await wait(900);
    const hover = lastOf("quickinfo")?.body?.displayString ?? "";
    check("the edited passage types the new variable",
      /enemyName: string/.test(hover), hover || "(no quickinfo)");

    // The user's actual gesture: hover the newly added variable inside the
    // passage. The projection grew, so this line did not exist before the edit.
    const projectedTwee = toPosix(editTwee) + ".ts";
    const editedProj = projectTwee(readFileSync(editTwee, "utf8")).ts;
    const atEnemy = positionOf(editedProj, "enemyName");
    send("quickinfo", { file: projectedTwee, line: atEnemy.line, offset: atEnemy.offset });
    await wait(900);
    const inPassage = lastOf("quickinfo")?.body?.displayString ?? "";
    check("hovering the new variable inside the passage works",
      /enemyName/.test(inPassage), inPassage || JSON.stringify(lastOf("quickinfo")?.message || "(no response)"));
  });
  writeFileSync(editTwee, editOriginal);
  rmSync(path.join(editFixture, "reader.ts"), { force: true });
  // Keep this scenario's plugin log; the shared .tsserver.log is overwritten by
  // whichever run finishes last, which makes it useless for diagnosing here.
  writeFileSync(
    path.join(testDir, ".edit-scenario.log"),
    editRun.log.split("\n").filter((l) => l.includes("[tw-sugarcube]")).join("\n")
  );
  check("no language-service crash (passage edits)", !editRun.crashed, "Debug Failure seen");

  // ---------- typo detection ----------
  // Closing a container is what turns an unknown member into an error, and it is
  // the exact thing that made 0.4.0 unusable. Most of these checks are therefore
  // about what must NOT be reported.
  console.log("\ntypo detection (twSugarcube.typoDetection = true):");
  const typoFixture = path.join(testDir, "fixture-typos");
  const typoUse = toPosix(path.join(typoFixture, "use.ts"));
  const typoLegit = toPosix(path.join(typoFixture, "legit.ts"));
  const typoDynamic = toPosix(path.join(typoFixture, "dynamic.ts"));
  const typoRun = await withServer(typoFixture, async ({ proj, send, wait, diagnostics }) => {
    send("configurePlugin", { pluginName: "tw-sugarcube-ts-plugin", configuration: { strict: true, typoDetection: true } });
    send("open", { file: typoUse, projectRootPath: proj });
    send("open", { file: typoLegit, projectRootPath: proj });
    send("open", { file: typoDynamic, projectRootPath: proj });
    await wait(3000);

    send("semanticDiagnosticsSync", { file: typoUse });
    await wait(1600);
    const typo = diagnostics();
    check("a real typo is reported",
      typo.some((d) => /Property 'attck' does not exist/.test(d)), typo.join(" | ") || "(none)");
    check("...and suggests the intended member",
      typo.some((d) => /Did you mean 'attack'/.test(d)), typo.join(" | ") || "(no suggestion)");

    // The false-positive classes that made 0.4.0 unusable.
    send("semanticDiagnosticsSync", { file: typoLegit });
    await wait(1600);
    const legit = diagnostics();
    check("a member assigned in TypeScript is not a typo",
      !legit.some((d) => /'attack'/.test(d)), legit.join(" | "));
    check("a variable created by a passage <<set>> is not a typo",
      !legit.some((d) => /'hp'/.test(d)), legit.join(" | "));
    check("a settings member is never a typo (Setting API creates them)",
      !legit.some((d) => /'volume'/.test(d)), legit.join(" | "));
    check("nothing legitimate is reported at all", legit.length === 0, legit.join(" | "));

    send("semanticDiagnosticsSync", { file: typoDynamic });
    await wait(1600);
    const dyn = diagnostics();
    check("a computed assignment keeps its container open",
      dyn.length === 0, dyn.join(" | "));

  });
  check("no language-service crash (typo detection)", !typoRun.crashed, "Debug Failure seen");

  // Object.assign reopens its container for the WHOLE project, not just the file
  // it appears in — so this needs its own fixture. (Adding it to the one above
  // correctly killed typo detection there, which is exactly the point.)
  const assignFixture = path.join(testDir, "fixture-typos-assign");
  const assignUse = toPosix(path.join(assignFixture, "assign.ts"));
  const assignRun = await withServer(assignFixture, async ({ proj, send, wait, diagnostics }) => {
    send("configurePlugin", { pluginName: "tw-sugarcube-ts-plugin", configuration: { strict: true, typoDetection: true } });
    send("open", { file: assignUse, projectRootPath: proj });
    await wait(2600);
    send("semanticDiagnosticsSync", { file: assignUse });
    await wait(1600);
    const diags = diagnostics();
    check("Object.assign keeps its container open project-wide",
      diags.length === 0, diags.join(" | "));
  });
  check("no language-service crash (Object.assign)", !assignRun.crashed, "Debug Failure seen");

  // ---------- containers reached through a local alias ----------
  // `const sv = State.variables; sv.hp = 100` is how a lot of story code is
  // actually written. Nothing about `sv.hp` looks like a container member, so
  // before aliases were followed the member had no type, no definition site, and
  // — with typo detection on — was reported as nonexistent at the one place it
  // is created. Typo detection is on here because it is what makes the negatives
  // below observable at all.
  console.log("\nlocal aliases (const sv = State.variables):");
  const aliasFixture = path.join(testDir, "fixture-alias");
  const aliasWorld = toPosix(path.join(aliasFixture, "world.ts"));
  const aliasUse = toPosix(path.join(aliasFixture, "use.ts"));
  const aliasMisuse = toPosix(path.join(aliasFixture, "misuse.ts"));
  const aliasWorldContent = readFileSync(path.join(aliasFixture, "world.ts"), "utf8");
  const aliasUseContent = readFileSync(path.join(aliasFixture, "use.ts"), "utf8");
  const aliasRun = await withServer(aliasFixture, async ({ proj, send, wait, diagnostics, lastOf }) => {
    send("configurePlugin", { pluginName: "tw-sugarcube-ts-plugin", configuration: { strict: true, typoDetection: true } });
    send("open", { file: aliasWorld, projectRootPath: proj });
    send("open", { file: aliasUse, projectRootPath: proj });
    send("open", { file: aliasMisuse, projectRootPath: proj });
    await wait(3000);

    send("semanticDiagnosticsSync", { file: aliasWorld });
    await wait(1600);
    const world = diagnostics();
    check("assigning through an alias is not itself an error", world.length === 0, world.join(" | "));

    send("semanticDiagnosticsSync", { file: aliasUse });
    await wait(1600);
    const use = diagnostics();
    check("members created through an alias exist on the container",
      use.length === 0, use.join(" | "));

    // Without this, "clean file" above would pass just as well with `name`/`hp`
    // left `any` by the index signature.
    send("semanticDiagnosticsSync", { file: aliasMisuse });
    await wait(1600);
    const bad = diagnostics();
    check("an alias-derived type is enforced, not just present",
      bad.some((d) => /Type 'number' is not assignable to type 'string'/.test(d)),
      bad.join(" | ") || "(no diagnostics — hp is still `any`)");
    check("a binding that only shares the alias's name is not the container",
      bad.some((d) => /Property 'fromShadow' does not exist/.test(d)), bad.join(" | "));
    check("a `let` is not an alias (it can be re-pointed)",
      bad.some((d) => /Property 'fromLet' does not exist/.test(d)), bad.join(" | "));
    check("nothing else is reported", bad.length === 3, bad.join(" | "));

    // Go-to-definition must land on `sv.name = "Hero"`, the real creation site.
    const atName = positionOf(aliasUseContent, "variables.name");
    send("definitionAndBoundSpan", { file: aliasUse, line: atName.line, offset: atName.offset + "variables.".length });
    await wait(900);
    const def = lastOf("definitionAndBoundSpan")?.body?.definitions?.[0];
    check("go-to-definition lands on the assignment made through the alias",
      !!def && /world\.ts$/i.test(def.file) && def.start.line === positionOf(aliasWorldContent, 'sv.name = "Hero"').line,
      def ? `${def.file}:${def.start.line}` : "(no definition)");
  });
  check("no language-service crash (aliases)", !aliasRun.crashed, "Debug Failure seen");

  // Default-off: the same fixture must be silent without the setting.
  const typoOffRun = await withServer(typoFixture, async ({ proj, send, wait, diagnostics }) => {
    send("open", { file: typoUse, projectRootPath: proj });
    await wait(2600);
    send("semanticDiagnosticsSync", { file: typoUse });
    await wait(1600);
    const diags = diagnostics();
    check("typo detection is off by default", diags.length === 0, diags.join(" | "));
  });
  check("no language-service crash (typo detection off)", !typoOffRun.crashed, "Debug Failure seen");

  // ---------- permissive mode ----------
  console.log("\npermissive mode (twSugarcube.strict = false):");
  const permRun = await withServer(fixture, async ({ proj, send, wait, diagnostics }) => {
    send("configure", { preferences: {} });
    send("configurePlugin", { pluginName: "tw-sugarcube-ts-plugin", configuration: { strict: false } });
    send("open", { file: usePath, projectRootPath: proj });
    await wait(2600);
    send("semanticDiagnosticsSync", { file: usePath });
    await wait(1600);
    const diags = diagnostics();
    check("no errors when permissive", diags.length === 0, diags.join(" | "));
  });
  check("no language-service crash (permissive)", !permRun.crashed, "Debug Failure seen in responses or log");

  // ---------- two configured projects in one workspace ----------
  // The passage cache, reload queue, throttle, and directory watcher were once
  // module globals. With two projects, each one's getExternalFiles forces a scan
  // of ITS tree, and the shared deletion pass then evicted the OTHER project's
  // projections as "missing" — so the two projects perpetually invalidated each
  // other and a passage in whichever project wasn't scanned last went dark. This
  // exercises both projects at once and re-checks the first after the second has
  // been active, which is exactly when the old shared cache dropped it.
  console.log("\ntwo projects in one workspace:");
  const multiFixture = path.join(testDir, "fixture-twee-multi");
  const projADir = toPosix(path.join(multiFixture, "projA"));
  const projBDir = toPosix(path.join(multiFixture, "projB"));
  const worldA = toPosix(path.join(multiFixture, "projA", "world.ts"));
  const worldB = toPosix(path.join(multiFixture, "projB", "world.ts"));
  const passageA = toPosix(path.join(multiFixture, "projA", "story.twee")) + ".ts";
  const passageB = toPosix(path.join(multiFixture, "projB", "story.twee")) + ".ts";
  // A passage CREATED in the second project after load. Under the old single
  // global watcher, only the first project (projA) was ever watched — projA and
  // projB are siblings, so projA's recursive watcher never covered projB, and a
  // new passage there was invisible. This is the deterministic regression guard;
  // the eviction bug self-heals on the next query, but an unwatched project does
  // not, so a created-after-load passage in projB is what reliably breaks.
  const createdB = path.join(multiFixture, "projB", "created.twee");
  const createdBProjected = toPosix(createdB) + ".ts";
  rmSync(createdB, { force: true }); // ensure absent at load
  const multiRun = await withServer(multiFixture, async ({ send, wait, diagnostics, lastOf }) => {
    send("open", { file: worldA, projectRootPath: projADir });
    send("open", { file: worldB, projectRootPath: projBDir });
    await wait(3200);

    // Each passage must join its OWN project's tsconfig, not get merged.
    send("projectInfo", { file: passageA, needFileNameList: false });
    await wait(800);
    const ownerA = lastOf("projectInfo")?.body?.configFileName ?? "";
    send("projectInfo", { file: passageB, needFileNameList: false });
    await wait(800);
    const ownerB = lastOf("projectInfo")?.body?.configFileName ?? "";
    check("each passage joins its own project",
      /projA[\\/]tsconfig\.json$/i.test(ownerA) && /projB[\\/]tsconfig\.json$/i.test(ownerB),
      `A=${ownerA} B=${ownerB}`);

    // Both projections live at once: each reports ITS OWN wrong-argument error
    // (A expects number, B expects string), so the two texts are distinguishable.
    send("semanticDiagnosticsSync", { file: passageA });
    await wait(1500);
    const diagA = diagnostics();
    check("project A's passage is analyzed",
      diagA.some((d) => /'string' is not assignable to parameter of type 'number'/.test(d)), diagA.join(" | "));

    send("semanticDiagnosticsSync", { file: passageB });
    await wait(1500);
    const diagB = diagnostics();
    check("project B's passage is analyzed",
      diagB.some((d) => /'number' is not assignable to parameter of type 'string'/.test(d)), diagB.join(" | "));

    // Create a passage in the SECOND project after load. It needs projB's own
    // watcher to be noticed and reloaded into projB's roots; with the old single
    // watcher (bound to projA) it stays invisible. attackB expects a string, so
    // once analyzed the wrong number argument must surface as an error.
    writeFileSync(createdB, ":: New\n<<run setup.attackB(7)>>\n");
    await wait(1800); // watcher debounce (150ms) + project reload
    send("semanticDiagnosticsSync", { file: createdBProjected });
    await wait(1500);
    const diagCreated = diagnostics();
    check("a passage created in the second project is watched and analyzed",
      diagCreated.some((d) => /'number' is not assignable to parameter of type 'string'/.test(d)),
      diagCreated.join(" | ") || "(no diagnostics — projB was never watched)");
  });
  rmSync(createdB, { force: true });
  check("no language-service crash (multi-project)", !multiRun.crashed, "Debug Failure seen");

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log("FAILED: " + failed.map((f) => f.name).join(", "));
    process.exit(1);
  }
}

main();
