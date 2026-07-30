#!/usr/bin/env node
// Static linter for SugarCube TypeScript projects.
//
// Mirrors what the editor extension checks — parameter/return typing on
// setup/State.variables/State.temporary/settings, and (opt-in) typo detection —
// but over the WHOLE project at once, for a pre-commit hook or CI. It shares the
// exact analysis core the plugin uses (the tw-sugarcube-analyzer package), so
// the two can't drift.
//
// It builds a real Program from the project's tsconfig, injects one virtual .ts
// per .twee (the same projection the editor sees) plus the generated
// augmentation, type-checks, and maps passage diagnostics back onto .twee spans.
"use strict";

const path = require("path");
const { norm } = require("tw-sugarcube-analyzer/analyzer.js");
const twee = require("tw-sugarcube-analyzer/twee.js");
const { collectProjections, buildAugmentation, MAX_GENERATION_PASSES } =
  require("tw-sugarcube-analyzer/augmentation.js");

function fail(message) {
  process.stderr.write(`tw-sugarcube-lint: ${message}\n`);
  process.exit(2); // 2 = the linter itself could not run; 1 = lint findings
}

// --- arguments --------------------------------------------------------------
function parseArgs(argv) {
  const opts = { dir: ".", strict: true, typoDetection: false, format: "pretty" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--no-strict") opts.strict = false;
    else if (a === "--typos" || a === "--typo-detection") opts.typoDetection = true;
    else if (a === "--json") opts.format = "json";
    else if (a === "--help" || a === "-h") opts.help = true;
    else if (a.startsWith("-")) fail(`unknown option ${a}`);
    else opts.dir = a;
  }
  return opts;
}

const HELP = `Usage: tw-sugarcube-lint [dir] [options]

Type-checks a SugarCube TypeScript project — .ts/.js sources and the code
embedded in .twee passages — the same way the editor extension does.

Options:
  --typos, --typo-detection   Report members never assigned anywhere (e.g.
                              setup.attck). Requires strict. Off by default,
                              because members created dynamically or in files
                              outside the project would be reported as typos.
  --no-strict                 Don't type recovered members; only report errors
                              TypeScript finds without the augmentation.
  --json                      Machine-readable output.
  -h, --help                  This message.

Exit codes: 0 clean, 1 lint findings, 2 the linter could not run.`;

// --- locate a usable TypeScript --------------------------------------------
// We need the JavaScript compiler API (createProgram + the type-checker types).
// TypeScript split into TWO lines: the 6.x "JS API" line has that API, while the
// 7.x native compiler ships as a CLI whose programmatic API is absent until 7.1.
// A story project may well be on 7.x for its build (`tsc`), so preferring the
// project's install blindly loads a TypeScript that can't be driven in-process.
//
// So: use the project's install only if it actually exposes the API; otherwise
// fall back to ours (a 6.x/5.x line), which analyzes the same code the same way
// — the augmentation and member checks don't depend on 7-specific behaviour, and
// the editor already checks with VS Code's own 6.x tsserver regardless.
//
// "ours" is `typescript-api`, an ALIAS for typescript@^6 (see package.json), and
// it is a real dependency rather than a dev one. That matters: this used to fall
// back to a plain `require("typescript")`, which resolved only because the repo
// had TypeScript as a devDependency — so the CLI worked from a checkout and died
// the moment anyone installed it from npm, on the very projects it most needs to
// serve (a story on the native 7.x line). The alias also keeps our copy from
// colliding with whatever `typescript` the project itself pins.
function hasProgramApi(ts) {
  return !!(ts && typeof ts.createProgram === "function" && ts.TypeFormatFlags && ts.DiagnosticCategory);
}

function loadTypeScript(dir) {
  let projectVersion = null;
  try {
    const resolved = require.resolve("typescript", { paths: [path.resolve(dir)] });
    const ts = require(resolved);
    projectVersion = ts.version;
    if (hasProgramApi(ts)) return { ts, source: `project (${ts.version})` };
  } catch (e) { /* fall through */ }

  // `typescript` last, so a checkout without the alias installed still works.
  for (const name of ["typescript-api", "typescript"]) {
    try {
      const ts = require(name);
      if (!hasProgramApi(ts)) continue;
      if (projectVersion) {
        process.stderr.write(
          `tw-sugarcube-lint: the project's TypeScript ${projectVersion} has no in-process ` +
          `compiler API (native 7.x); analyzing with bundled ${ts.version} instead.\n`
        );
      }
      return { ts, source: `bundled (${ts.version})` };
    } catch (e) { /* try the next one */ }
  }

  fail("could not find a TypeScript with the JavaScript compiler API (need a 6.x/5.x line)");
}

function findTsconfig(ts, dir) {
  const found = ts.findConfigFile(path.resolve(dir), ts.sys.fileExists, "tsconfig.json");
  if (!found) fail(`no tsconfig.json found at or above ${path.resolve(dir)}`);
  return found;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { process.stdout.write(HELP + "\n"); return; }

  const { ts } = loadTypeScript(opts.dir);
  const configPath = findTsconfig(ts, opts.dir);
  const projectRoot = path.dirname(configPath);

  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  if (configFile.error) {
    fail(ts.flattenDiagnosticMessageText(configFile.error.messageText, "\n"));
  }
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, projectRoot);
  // A broken tsconfig (bad `extends`, invalid option) must fail loudly, not
  // lint against a half-parsed config. TS18003 ("No inputs were found") is
  // tolerated: a twee-only project has no .ts sources of its own, and the
  // passage projections are injected as roots below.
  const configErrors = (parsed.errors || []).filter((e) => e.code !== 18003);
  if (configErrors.length) {
    fail(configErrors.map((e) => ts.flattenDiagnosticMessageText(e.messageText, "\n")).join("\n"));
  }

  const projections = collectProjections(projectRoot, (message) =>
    process.stderr.write(`tw-sugarcube-lint: warning: ${message}\n`)
  );

  // The augmentation path sits inside the project so its relative
  // `import "twine-sugarcube"` resolves against the project's node_modules.
  const augPath = path.join(projectRoot, "__sugarcube-generated__.d.ts").replace(/\\/g, "/");

  // Generate the augmentation, then type-check against it. The pass loop lives
  // in tw-sugarcube-analyzer because the plugin, this CLI and tw-server's build
  // all need it and re-implementing it per consumer is how they drift.
  const { program, downgrades, converged } = buildAugmentation(ts, {
    rootNames: parsed.fileNames,
    options: parsed.options,
    augPath,
    projections,
    strict: opts.strict,
    typoDetection: opts.typoDetection,
  });
  // Recovery normally settles in two or three passes. If it hasn't, the findings
  // below are from a snapshot mid-flight rather than a settled one — say so
  // rather than presenting them as the whole truth.
  if (!converged) {
    process.stderr.write(
      `tw-sugarcube-lint: warning: recovered member types did not settle after ` +
      `${MAX_GENERATION_PASSES} passes; some findings may be missing\n`
    );
  }

  const findings = collectFindings(ts, program, projections, augPath)
    .concat(downgradeFindings(program, projections, downgrades));
  findings.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));
  report(findings, opts.format);
  // exitCode, not process.exit(): on Windows a piped stdout drains
  // asynchronously, and process.exit() truncates whatever hasn't flushed —
  // a large --json report would come out cut off mid-stream in CI.
  //
  // Errors decide the exit code, not the finding count: a downgrade warning says
  // the linter gave up on a type, not that the story is wrong, and failing CI on
  // one would turn a project red without a line of its code changing.
  process.exitCode = findings.some((f) => f.category === "Error") ? 1 : 0;
}

// Locate each downgrade in the file the author actually edits. The analyzer
// already mapped passage sites back onto their .twee document, so this only has
// to turn an offset into a line and column — via the projection's text for a
// passage, and the Program's own SourceFile for anything else.
function downgradeFindings(program, projections, downgrades) {
  if (!downgrades.length) return [];
  const bySource = new Map();
  for (const p of projections.values()) bySource.set(norm(p.source), p);
  const out = [];
  for (const d of downgrades) {
    const finding = { code: null, message: d.message, category: "Warning", rule: `type-downgraded/${d.reason}`, file: d.site.fileName };
    const projection = bySource.get(norm(d.site.fileName));
    if (projection) {
      const lineStarts = projection.lineStarts || (projection.lineStarts = lineStartsOf(projection.text));
      Object.assign(finding, lineColAt(lineStarts, d.site.start));
    } else {
      const sf = program.getSourceFile(d.site.fileName);
      if (!sf) continue; // nothing to point at; better silent than a bogus location
      const lc = sf.getLineAndCharacterOfPosition(d.site.start);
      finding.line = lc.line + 1;
      finding.column = lc.character + 1;
    }
    out.push(finding);
  }
  return out;
}

// Map a diagnostic to a user-facing location, translating passage projections
// back onto the .twee document.
function collectFindings(ts, program, projections, augPath) {
  const out = [];
  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile || /[\\/]node_modules[\\/]/.test(sf.fileName)) continue;
    if (norm(sf.fileName) === norm(augPath)) continue; // never surface the generated file
    // A parse error makes the semantic diagnostics that follow it unreliable
    // (the type-checker is working from a broken tree), so when a file has
    // syntax errors report those and skip the semantic cascade for that file.
    // Without this, a plain syntax error was invisible to the linter entirely.
    const syntactic = program.getSyntacticDiagnostics(sf);
    const diags = syntactic.length ? syntactic : program.getSemanticDiagnostics(sf);
    const projection = projections.get(norm(sf.fileName));
    for (const d of diags) {
      if (typeof d.start !== "number") continue;
      const finding = { code: d.code, message: ts.flattenDiagnosticMessageText(d.messageText, "\n"), category: ts.DiagnosticCategory[d.category] };
      if (projection) {
        // A diagnostic inside a projection must map to author text or be dropped
        // — the projection contains scaffolding the author never wrote.
        const mapped = twee.tsRangeToTwee(projection.segments, d.start, d.length || 1);
        if (!mapped) continue;
        finding.file = projection.source;
        // Reuse the text read in collectProjections, with line starts computed
        // once per file instead of re-slicing the whole file per diagnostic.
        const lineStarts = projection.lineStarts || (projection.lineStarts = lineStartsOf(projection.text));
        Object.assign(finding, lineColAt(lineStarts, mapped.start));
      } else {
        finding.file = sf.fileName;
        const lc = sf.getLineAndCharacterOfPosition(d.start);
        finding.line = lc.line + 1;
        finding.column = lc.character + 1;
      }
      out.push(finding);
    }
  }
  out.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));
  return out;
}

// Byte offset of each line start, computed once per file; offset -> line/column
// is then a binary search rather than an O(offset) slice per diagnostic.
function lineStartsOf(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  return starts;
}
function lineColAt(lineStarts, offset) {
  let lo = 0, hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= offset) lo = mid; else hi = mid - 1;
  }
  return { line: lo + 1, column: offset - lineStarts[lo] + 1 };
}

function report(findings, format) {
  if (format === "json") {
    process.stdout.write(JSON.stringify({ findings }, null, 2) + "\n");
    return;
  }
  if (!findings.length) {
    process.stdout.write("tw-sugarcube-lint: no problems found\n");
    return;
  }
  const rel = (f) => path.relative(process.cwd(), f).replace(/\\/g, "/");
  for (const f of findings) {
    // Our own findings have no TypeScript error number; printing "TS null" for
    // them would look like a bug in the reporter.
    const code = f.code ? `TS${f.code}  ` : "";
    process.stdout.write(`${rel(f.file)}:${f.line}:${f.column}  ${f.category.toLowerCase()}  ${code}${f.message}\n`);
  }
  const errors = findings.filter((f) => f.category === "Error").length;
  process.stdout.write(`\n${findings.length} problem${findings.length === 1 ? "" : "s"} (${errors} error${errors === 1 ? "" : "s"})\n`);
}

main();
