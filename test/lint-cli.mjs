// Tests for the command-line linter (bin/lint.js).
//
// The linter builds a real Program from the project's tsconfig rather than
// driving tsserver, so this verifies that path independently: passage errors map
// back onto .twee spans, exit codes are CI-appropriate, and typo detection has
// the same opt-in / false-positive-safe behaviour as the editor. It shares the
// analysis core with the plugin (ts-plugin/analyzer.js), so the tsserver smoke
// suite covers the same rules from the other side.
import { spawnSync } from "child_process";
import { mkdirSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const testDir = path.dirname(fileURLToPath(import.meta.url));

// The native-TS7 fallback fixture needs a resolvable `typescript` in its
// node_modules that LACKS the compiler API. node_modules is gitignored, so it's
// generated here rather than committed — otherwise a fresh checkout couldn't run
// this test.
function writeFakeTs7() {
  const dir = path.join(testDir, "fixture-fakets7", "node_modules", "typescript");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "typescript", version: "7.0.99", main: "index.js" }));
  writeFileSync(path.join(dir, "index.js"),
    "// Stand-in for the native TS7 compiler: resolvable, but no in-process JS API.\nmodule.exports = { version: \"7.0.99\" };\n");
}
writeFakeTs7();
const repoRoot = path.dirname(testDir);
const CLI = path.join(repoRoot, "bin", "lint.js");

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}${ok || !detail ? "" : `\n        ${detail}`}`);
};

function lint(fixture, args = []) {
  const r = spawnSync(process.execPath, [CLI, path.join(testDir, fixture), ...args], { encoding: "utf8" });
  return { code: r.status, out: r.stdout || "", err: r.stderr || "" };
}

console.log("lint CLI\n");

// --- passage type error maps back to .twee ---------------------------------
{
  const r = lint("fixture-lint");
  check("a passage type error is reported", /Argument of type 'string' is not assignable/.test(r.out), r.out);
  check("...located in the .twee file, not the projection",
    /story\.twee:3:\d+/.test(r.out) && !/story\.twee\.ts/.test(r.out), r.out);
  check("exit code is 1 when there are findings", r.code === 1, `exit ${r.code}`);
}

// --- a clean project exits 0 -----------------------------------------------
{
  const r = lint("fixture-lint-clean"); // reads passage-created variables, all valid
  check("a clean project reports nothing", /no problems found/.test(r.out), r.out);
  check("exit code is 0 when clean", r.code === 0, `exit ${r.code}: ${r.out}`);
}

// --- typo detection is opt-in ----------------------------------------------
{
  const off = lint("fixture-typos");
  check("a typo is NOT reported without --typos", off.code === 0 && !/attck/.test(off.out),
    `exit ${off.code}: ${off.out}`);

  const on = lint("fixture-typos", ["--typos"]);
  check("a typo IS reported with --typos", /Property 'attck' does not exist/.test(on.out), on.out);
  // Count finding lines by their location prefix; the summary line says "error" too.
  check("...and only the typo — nothing legitimate",
    on.out.split("\n").filter((l) => /:\d+:\d+ {2}error/.test(l)).length === 1, on.out);
  check("exit 1 on a typo finding", on.code === 1, `exit ${on.code}`);
}

// --- false-positive safety: the classes that broke 0.4.0 -------------------
{
  // settings members (Setting API), passage <<set>> variables, and members
  // assigned in .ts must never be reported even with typos on.
  const r = lint("fixture-typos", ["--typos"]);
  check("settings / passage / .ts members are not called typos",
    !/'hp'|'volume'|'attack' does not exist/.test(r.out), r.out);
}

// --- Object.assign keeps its container open --------------------------------
{
  const r = lint("fixture-typos-assign", ["--typos"]);
  check("Object.assign suppresses typo detection for that container", r.code === 0, `exit ${r.code}: ${r.out}`);
}

// --- machine-readable output ------------------------------------------------
{
  const r = lint("fixture-lint", ["--json"]);
  let parsed = null;
  try { parsed = JSON.parse(r.out); } catch (e) { /* leave null */ }
  check("--json emits parseable output with mapped locations",
    !!parsed && Array.isArray(parsed.findings) && parsed.findings.some((f) => /story\.twee$/.test(f.file) && f.line === 3),
    r.out.slice(0, 200));
}

// --- a project on the native TS 7.x compiler falls back gracefully ----------
// TS7 has no in-process compiler API, so loading the project's own TypeScript
// blindly would crash on ts.TypeFormatFlags. The fixture ships a fake TS 7.x
// (resolvable, no API) in its node_modules; the linter must fall back to the
// bundled TypeScript and still analyze correctly.
{
  const r = lint("fixture-fakets7");
  check("falls back to bundled TS when the project's is native 7.x",
    /native 7\.x|no in-process compiler API/.test(r.err), r.err || "(no notice on stderr)");
  check("...and still produces a real result", r.code === 0 && /no problems found/.test(r.out),
    `exit ${r.code}: ${r.out}`);
}

// --- all four tweego source extensions are analyzed ------------------------
// tweego recognizes .tw, .twee, .tw2, .twee2; the extension must cover the whole
// set, not just the two Twee 3 Language Tools associates.
{
  const r = lint("fixture-lint-ext");
  check("a .twee2 passage error is reported", /story\.twee2:2:\d+.*not assignable/.test(r.out), r.out);
  check("...and a .tw2 passage projects without spurious errors",
    !/extra\.tw2/.test(r.out) && r.out.split("\n").filter((l) => /:\d+:\d+  error/.test(l)).length === 1, r.out);
}

// --- the tool runs from any cwd (CI invokes it oddly) ----------------------
{
  const r = spawnSync(process.execPath, [CLI, path.join(testDir, "fixture-lint")], { encoding: "utf8", cwd: repoRoot });
  check("runs from a different cwd", r.status === 1 && /story\.twee/.test(r.stdout), `exit ${r.status}`);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log("FAILED: " + failed.map((f) => f.name).join(", "));
  process.exit(1);
}
