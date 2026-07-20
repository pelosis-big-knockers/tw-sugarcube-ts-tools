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
import path from "path";
import { fileURLToPath } from "url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.dirname(testDir);
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
    send("quickinfo", { file: projected, line: 4, offset: 8 });
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
    send("definitionAndBoundSpan", { file: projected, line: 4, offset: 8 });
    await wait(900);
    const def = lastOf("definitionAndBoundSpan")?.body?.definitions?.[0];
    check("go-to-definition from a passage lands on the source",
      !!def && /world\.ts$/i.test(def.file), def ? def.file : "(no definition)");
  });
  check("no language-service crash (passages)", !tweeRun.crashed, "Debug Failure seen in responses or log");
  check("no projected file written to the workspace",
    !existsSync(path.join(tweeFixture, "story.twee.ts")), "projection leaked to disk");

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
    send("quickinfo", { file: projectedTwee, line: 5, offset: 20 });
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

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log("FAILED: " + failed.map((f) => f.name).join(", "));
    process.exit(1);
  }
}

main();
