#!/usr/bin/env node
// Static linter for SugarCube TypeScript projects.
//
// Mirrors what the editor extension checks — parameter/return typing on
// setup/State.variables/State.temporary/settings, and (opt-in) typo detection —
// but over the WHOLE project at once, for a pre-commit hook or CI. It shares the
// exact analysis core the plugin uses (ts-plugin/analyzer.js + twee.js), so the
// two can't drift.
//
// It builds a real Program from the project's tsconfig, injects one virtual .ts
// per .twee (the same projection the editor sees) plus the generated
// augmentation, type-checks, and maps passage diagnostics back onto .twee spans.
"use strict";

const fs = require("fs");
const path = require("path");
const { createAnalyzer, norm } = require("../ts-plugin/analyzer.js");
const twee = require("../ts-plugin/twee.js");

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

  try {
    const ts = require("typescript");
    if (hasProgramApi(ts)) {
      if (projectVersion) {
        process.stderr.write(
          `tw-sugarcube-lint: the project's TypeScript ${projectVersion} has no in-process ` +
          `compiler API (native 7.x); analyzing with bundled ${ts.version} instead.\n`
        );
      }
      return { ts, source: `bundled (${ts.version})` };
    }
  } catch (e) { /* fall through */ }

  fail("could not find a TypeScript with the JavaScript compiler API (need a 6.x/5.x line)");
}

function findTsconfig(ts, dir) {
  const found = ts.findConfigFile(path.resolve(dir), ts.sys.fileExists, "tsconfig.json");
  if (!found) fail(`no tsconfig.json found at or above ${path.resolve(dir)}`);
  return found;
}

// Every .twee under the project root, projected to TypeScript.
function collectProjections(root) {
  const projections = new Map(); // normalized virtual path -> { content, segments, source, virtual, text }
  const walk = (d, depth) => {
    if (depth > twee.MAX_SCAN_DEPTH) return;
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const entry of entries) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name[0] === ".") continue;
        walk(full, depth + 1);
      } else if (twee.isTweeFile(entry.name)) {
        let text = "";
        try { text = fs.readFileSync(full, "utf8"); } catch (e) { continue; }
        let projected = { ts: "", segments: [] };
        try { projected = twee.project(text); } catch (e) { /* keep empty */ }
        const source = full.replace(/\\/g, "/");
        const virtual = source + ".ts";
        // The analyzer's lookup contract keys projections by norm() (which
        // case-folds), so two twee files differing only in case would silently
        // collapse to one entry and the other would never be linted — rare, but
        // say so instead of reporting a clean run.
        const prior = projections.get(norm(virtual));
        if (prior && prior.source !== source) {
          process.stderr.write(
            `tw-sugarcube-lint: warning: ${source} and ${prior.source} differ only by case; ` +
            `only one will be linted\n`
          );
        }
        // Keep the source text: the reporter maps diagnostics back onto it, and
        // re-reading the file per diagnostic was pure waste.
        projections.set(norm(virtual), {
          content: projected.ts, segments: projected.segments, source, virtual, text,
        });
      }
    }
  };
  walk(root, 0);
  return projections;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { process.stdout.write(HELP + "\n"); return; }

  const { ts } = loadTypeScript(opts.dir);
  const analyzer = createAnalyzer(ts);
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

  const projections = collectProjections(projectRoot);

  // Two synthetic files live only in memory: the augmentation and each passage
  // projection. The augmentation path sits inside the project so its relative
  // `import "twine-sugarcube"` resolves against the project's node_modules.
  const augPath = path.join(projectRoot, "__sugarcube-generated__.d.ts").replace(/\\/g, "/");
  const synthetic = new Map(); // normalized path -> content
  for (const proj of projections.values()) synthetic.set(norm(proj.virtual), proj.content);
  synthetic.set(norm(augPath), ""); // filled after the first pass

  const rootNames = parsed.fileNames.concat([...projections.values()].map((p) => p.virtual), augPath);

  const host = ts.createCompilerHost(parsed.options, true);
  const origReadFile = host.readFile.bind(host);
  const origFileExists = host.fileExists.bind(host);
  const origGetSource = host.getSourceFile.bind(host);
  host.readFile = (f) => (synthetic.has(norm(f)) ? synthetic.get(norm(f)) : origReadFile(f));
  host.fileExists = (f) => (synthetic.has(norm(f)) ? true : origFileExists(f));
  // Two programs are built back to back (type recovery, then the real check),
  // and the default host re-reads and re-parses every file per program. Nothing
  // on disk changes between the passes, so cache the parsed SourceFiles; only
  // the augmentation's content differs, and its cache entry is keyed on content
  // so the second pass re-parses exactly that one file.
  // Keyed by the EXACT file name, not norm(): norm lowercases, and on a
  // case-sensitive filesystem two real files differing only in case would
  // collapse into one cache entry — the second would be served the first's
  // SourceFile under the wrong name and never actually parsed.
  const sourceCache = new Map(); // exact path -> { content, sf }
  host.getSourceFile = (fileName, langVersion, onError, shouldCreate) => {
    const content = synthetic.has(norm(fileName)) ? synthetic.get(norm(fileName)) : null;
    const hit = sourceCache.get(fileName);
    if (hit && hit.content === content) return hit.sf;
    const sf = content !== null
      ? ts.createSourceFile(fileName, content, langVersion, true)
      : origGetSource(fileName, langVersion, onError, shouldCreate);
    if (sf) sourceCache.set(fileName, { content, sf });
    return sf;
  };

  // Pass 1: a program with an empty augmentation, purely to recover member
  // types by scanning assignments. Pass 2: type-check against the real one.
  let program = ts.createProgram(rootNames, parsed.options, host);
  synthetic.set(
    norm(augPath),
    analyzer.generate(program, augPath, opts.strict, opts.typoDetection && opts.strict, projections)
  );
  program = ts.createProgram(rootNames, parsed.options, host);

  const findings = collectFindings(ts, program, projections, augPath);
  report(findings, opts.format);
  // exitCode, not process.exit(): on Windows a piped stdout drains
  // asynchronously, and process.exit() truncates whatever hasn't flushed —
  // a large --json report would come out cut off mid-stream in CI.
  process.exitCode = findings.length ? 1 : 0;
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
    process.stdout.write(`${rel(f.file)}:${f.line}:${f.column}  ${f.category.toLowerCase()}  TS${f.code}  ${f.message}\n`);
  }
  const errors = findings.filter((f) => f.category === "Error").length;
  process.stdout.write(`\n${findings.length} problem${findings.length === 1 ? "" : "s"} (${errors} error${errors === 1 ? "" : "s"})\n`);
}

main();
