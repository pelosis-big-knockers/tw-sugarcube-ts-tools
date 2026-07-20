// Twee -> TypeScript projection.
//
// SugarCube passages embed JavaScript in macros (`<<run setup.foo()>>`) and
// reference story variables with sigils (`$hp`, `_scratch`). This module turns a
// .twee file into an equivalent TypeScript document plus a position map, so the
// normal TypeScript language service can answer hover / completion / go-to-def /
// diagnostics for passage code.
//
// The projection is deliberately lossy in one direction only: everything we emit
// must correspond to something the author wrote, so a diagnostic can always be
// mapped back to a real span. Text we can't confidently interpret is skipped
// rather than guessed at — a missing feature is recoverable, a diagnostic
// pointing at the wrong place is not.
"use strict";

// Sigils: `$x` is State.variables.x, `_x` is State.temporary.x.
const STORY_PREFIX = "State.variables.";
const TEMP_PREFIX = "State.temporary.";

const isIdentStart = (c) => /[A-Za-z_$]/.test(c);
const isIdentPart = (c) => /[A-Za-z0-9_$]/.test(c);

// SugarCube accepts word forms for most JavaScript operators. They're not valid
// TypeScript, so an unrewritten `$hp gt 0` would surface as a syntax error on the
// author's perfectly good passage. Rewritten to the same length where possible so
// position mapping stays character-exact.
const WORD_OPERATORS = new Map([
  ["is", "==="], ["isnot", "!=="], ["eq", "=="], ["neq", "!="],
  ["gt", ">"], ["gte", ">="], ["lt", "<"], ["lte", "<="],
  ["and", "&&"], ["or", "||"], ["not", "!"], ["def", "!!"], ["ndef", "!"],
]);

// Macros whose body is a bare expression we can evaluate as a statement.
const EXPRESSION_MACROS = new Set(["=", "-", "print", "run", "capture"]);
// Macros whose body is a condition.
const CONDITION_MACROS = new Set(["if", "elseif", "unless"]);

class Builder {
  constructor() {
    this.ts = "";
    // Each segment maps a run of TS text back to a run of twee text. Equal
    // lengths mean an exact character-for-character correspondence; unequal
    // lengths (a rewritten sigil) map by clamping to the segment start.
    this.segments = [];
  }
  // Text that appears identically in both documents.
  verbatim(text, tweeStart) {
    if (!text) return;
    this.segments.push({ tsStart: this.ts.length, tsLength: text.length, tweeStart, tweeLength: text.length });
    this.ts += text;
  }
  // Text we rewrote (`$hp` -> `State.variables.hp`), still anchored to its source.
  mapped(tsText, tweeStart, tweeLength) {
    this.segments.push({ tsStart: this.ts.length, tsLength: tsText.length, tweeStart, tweeLength });
    this.ts += tsText;
  }
  // Scaffolding with no counterpart in the source; never a diagnostic target.
  raw(tsText) {
    this.ts += tsText;
  }
}

// Rewrite one JavaScript-ish expression, resolving sigils and (for <<set>>) the
// `to` assignment keyword. String literals are copied untouched so `"$5.00"` and
// `'go to town'` survive.
function emitExpression(builder, text, base, opts) {
  const allowTo = !!(opts && opts.allowTo);
  let i = 0;
  let chunkStart = 0;
  const flush = (end) => {
    if (end > chunkStart) builder.verbatim(text.slice(chunkStart, end), base + chunkStart);
  };

  while (i < text.length) {
    const c = text[i];

    // String literals: copy verbatim, no rewriting inside.
    if (c === '"' || c === "'") {
      const quote = c;
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === "\\") { j += 2; continue; }
        if (text[j] === quote) { j++; break; }
        j++;
      }
      i = j;
      continue;
    }

    // Template literals: the quoted text is copied verbatim, but `${...}`
    // substitutions are real expressions — SugarCube resolves sigils inside
    // them, so `${$hp}` must become `${State.variables.hp}` or the projection
    // reports "Cannot find name '$hp'" on perfectly good passage code.
    if (c === "`") {
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === "\\") { j += 2; continue; }
        if (text[j] === "`") { j++; break; }
        if (text[j] === "$" && text[j + 1] === "{") {
          const subStart = j + 2;
          const subEnd = findSubstitutionEnd(text, subStart);
          flush(subStart); // everything through the `${` is verbatim
          emitExpression(builder, text.slice(subStart, subEnd), base + subStart, { allowTo: false });
          chunkStart = subEnd; // the `}` and the rest rejoin the verbatim run
          j = subEnd;
          continue;
        }
        j++;
      }
      i = j;
      continue;
    }

    // Line and block comments: copy verbatim, no rewriting inside, so a `$hp` or
    // a word operator that happens to sit in a comment isn't turned into code.
    if (c === "/" && (text[i + 1] === "/" || text[i + 1] === "*")) {
      let j = i + 2;
      if (text[i + 1] === "/") {
        while (j < text.length && text[j] !== "\n") j++;
      } else {
        while (j < text.length && !(text[j] === "*" && text[j + 1] === "/")) j++;
        if (j < text.length) j += 2; // consume the closing */
      }
      i = j;
      continue;
    }

    const prev = i > 0 ? text[i - 1] : "";
    const atTokenStart = !isIdentPart(prev) && prev !== ".";

    // $story / _temp variables.
    if ((c === "$" || c === "_") && atTokenStart && i + 1 < text.length && isIdentStart(text[i + 1]) && text[i + 1] !== "$") {
      let j = i + 1;
      while (j < text.length && isIdentPart(text[j])) j++;
      const name = text.slice(i + 1, j);
      flush(i);
      builder.mapped((c === "$" ? STORY_PREFIX : TEMP_PREFIX) + name, base + i, j - i);
      i = j;
      chunkStart = j;
      continue;
    }

    // Word-form operators. `to` is assignment and only valid inside <<set>>;
    // the comparison/logical words are valid anywhere.
    if (atTokenStart && isIdentStart(c) && c !== "$") {
      let j = i;
      while (j < text.length && isIdentPart(text[j])) j++;
      const word = text.slice(i, j);
      // A word only reads as an operator when it isn't a property (`setup.to`,
      // guarded by atTokenStart) and isn't a call (`is(...)`).
      const next = text.slice(j).match(/^\s*\(/);
      const replacement = allowTo && word === "to" ? "=" : (next ? null : WORD_OPERATORS.get(word));
      if (replacement) {
        flush(i);
        builder.mapped(replacement, base + i, word.length);
        i = j;
        chunkStart = j;
        continue;
      }
      i = j;
      continue;
    }

    i++;
  }
  flush(text.length);
}

// The index of the `}` that closes a template-literal substitution opened at
// `from` (just past the `${`), or text.length if unterminated. Braces inside
// nested string/template literals don't count toward the depth.
function findSubstitutionEnd(text, from) {
  let depth = 1;
  let k = from;
  while (k < text.length) {
    const d = text[k];
    if (d === '"' || d === "'" || d === "`") {
      const quote = d;
      k++;
      while (k < text.length) {
        if (text[k] === "\\") { k += 2; continue; }
        if (text[k] === quote) { k++; break; }
        k++;
      }
      continue;
    }
    if (d === "{") depth++;
    else if (d === "}") { depth--; if (depth === 0) return k; }
    k++;
  }
  return k;
}

// Find `<<...>>` macros. Quote-aware so `<<print "a>>b">>` closes correctly.
function findMacros(text) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf("<<", i);
    if (open === -1) break;
    let j = open + 2;
    let close = -1;
    let restart = -1;
    while (j < text.length) {
      const c = text[j];
      if (c === '"' || c === "'" || c === "`") {
        const quote = c;
        j++;
        while (j < text.length) {
          if (text[j] === "\\") { j += 2; continue; }
          if (text[j] === quote) { j++; break; }
          j++;
        }
        continue;
      }
      // A `>>` inside a block comment must not close the macro early. (Line
      // comments are left alone: a `//` runs to end of line, and in the common
      // single-line macro that would swallow the real closing `>>`.)
      if (c === "/" && text[j + 1] === "*") {
        j += 2;
        while (j < text.length && !(text[j] === "*" && text[j + 1] === "/")) j++;
        if (j < text.length) j += 2;
        continue;
      }
      // A bare `<<` before any `>>` means the current open wasn't a macro at
      // all (prose like `damage << armor`) — restart the scan from the real
      // opener instead of swallowing it into this one's body.
      if (c === "<" && text[j + 1] === "<") { restart = j; break; }
      if (c === ">" && text[j + 1] === ">") { close = j; break; }
      j++;
    }
    if (restart !== -1) { i = restart; continue; }
    if (close === -1) {
      // Unterminated scan (a stray `<<` followed by an unpaired quote can run
      // to end-of-text). Only this span is unreliable — resume right after the
      // opener so the rest of the document still projects.
      i = open + 2;
      continue;
    }
    out.push({ start: open, end: close + 2, inner: text.slice(open + 2, close) });
    i = close + 2;
  }
  return out;
}

// Split a macro body into its name and argument text, preserving offsets.
function splitMacro(inner, innerBase) {
  let k = 0;
  while (k < inner.length && /\s/.test(inner[k])) k++;
  if (k >= inner.length) return null;
  // `<<=` and `<<-` are sigil macros with no whitespace requirement.
  if (inner[k] === "=" || inner[k] === "-") {
    return { name: inner[k], argStart: innerBase + k + 1, arg: inner.slice(k + 1) };
  }
  let e = k;
  while (e < inner.length && /[A-Za-z0-9_]/.test(inner[e])) e++;
  return { name: inner.slice(k, e), argStart: innerBase + e, arg: inner.slice(e) };
}

// Naked `$story` / `_temporary` references in passage prose (outside macros) —
// SugarCube interpolates both, so they deserve hover and completion too. The
// guards keep false positives out of ordinary text: a sigil must be at a token
// start (not mid-word like `snake_case`), followed by an identifier, and not by
// its own sigil char — `$$` is an escaped dollar and `__x__` is underline markup,
// neither a variable. When in doubt it skips: a missing hover is recoverable, a
// wrong one isn't.
function emitProseVariables(builder, text, base, from, to) {
  let i = from;
  while (i < to) {
    const c = text[i];
    if (c !== "$" && c !== "_") { i++; continue; }
    const prev = i > 0 ? text[i - 1] : "";
    if (isIdentPart(prev) || prev === ".") { i++; continue; }
    const next = text[i + 1];
    if (i + 1 >= to || !isIdentStart(next) || next === c) { i++; continue; }
    let j = i + 1;
    while (j < to && isIdentPart(text[j])) j++;
    // Allow `$player.name` / `_scratch.field`
    while (j < to && text[j] === "." && j + 1 < to && isIdentStart(text[j + 1])) {
      j++;
      while (j < to && isIdentPart(text[j])) j++;
    }
    const whole = text.slice(i, j);
    emitExpression(builder, whole, base + i, { allowTo: false });
    builder.raw(";\n");
    i = j;
  }
}

/**
 * Project a .twee document into TypeScript.
 * Returns { ts, segments } where segments map TS ranges to twee ranges.
 */
function project(text) {
  const builder = new Builder();
  const macros = findMacros(text);
  let cursor = 0;

  for (const macro of macros) {
    emitProseVariables(builder, text, 0, cursor, macro.start);
    cursor = macro.end;

    const parts = splitMacro(macro.inner, macro.start + 2);
    if (!parts) continue;
    const { name, arg, argStart } = parts;

    // The scaffolding that closes each emission starts on its own line: the
    // argument may end in a `//` comment, which would otherwise swallow the
    // `;` / `) {}` and leave the projection syntactically broken.
    if (EXPRESSION_MACROS.has(name)) {
      if (!arg.trim()) continue;
      emitExpression(builder, arg, argStart, { allowTo: false });
      builder.raw("\n;\n");
    } else if (CONDITION_MACROS.has(name)) {
      if (!arg.trim()) continue;
      builder.raw("if (");
      emitExpression(builder, arg, argStart, { allowTo: false });
      builder.raw("\n) {}\n");
    } else if (name === "set") {
      if (!arg.trim()) continue;
      emitExpression(builder, arg, argStart, { allowTo: true });
      builder.raw("\n;\n");
    }
    // Unknown/user-defined macros: their arguments are SugarCube's own
    // argument grammar (bare words, links), not JavaScript. Projecting them
    // would invent errors, so they're skipped.
  }
  emitProseVariables(builder, text, 0, cursor, text.length);

  return { ts: builder.ts, segments: builder.segments };
}

// --- position mapping -------------------------------------------------------

function tsOffsetToTwee(segments, offset) {
  for (const s of segments) {
    if (offset >= s.tsStart && offset <= s.tsStart + s.tsLength) {
      const delta = offset - s.tsStart;
      // Exact correspondence when the text wasn't rewritten.
      if (s.tsLength === s.tweeLength) return s.tweeStart + delta;
      return s.tweeStart;
    }
  }
  return null;
}

function tweeOffsetToTs(segments, offset) {
  for (const s of segments) {
    if (offset >= s.tweeStart && offset <= s.tweeStart + s.tweeLength) {
      const delta = offset - s.tweeStart;
      if (s.tsLength === s.tweeLength) return s.tsStart + delta;
      // Rewritten: aim at the end of the emitted text, which is the member name
      // (`State.variables.hp` <- `$hp`), so hover lands on the property.
      return s.tsStart + s.tsLength;
    }
  }
  return null;
}

// Map a TS range back to a twee range, for diagnostics.
function tsRangeToTwee(segments, start, length) {
  const from = tsOffsetToTwee(segments, start);
  if (from === null) return null;
  const toRaw = tsOffsetToTwee(segments, start + length);
  const to = toRaw === null || toRaw <= from ? from + length : toRaw;
  return { start: from, length: Math.max(1, to - from) };
}

// The Twee source extensions tweego recognizes: .tw / .twee, plus the Twee2
// variants .tw2 / .twee2. Defined once here so the plugin, the editor providers,
// and the CLI can't drift (package.json's static globs mirror this list — keep
// them in sync when this changes).
const TWEE_EXTENSIONS = ["twee", "tw", "twee2", "tw2"];
const TWEE_FILE_RE = new RegExp(`\\.(${TWEE_EXTENSIONS.join("|")})$`, "i");
const isTweeFile = (name) => TWEE_FILE_RE.test(name);
// A VS Code DocumentSelector glob, e.g. "**/*.{twee,tw,twee2,tw2}".
const TWEE_GLOB = `**/*.{${TWEE_EXTENSIONS.join(",")}}`;

// How deep the plugin and CLI walk the project tree for .twee files. Defined
// once here so the two can't disagree: they used to (8 vs 12), which meant a
// deeply nested passage could lint clean yet be invisible to the editor. Just a
// runaway/symlink-loop backstop — real projects don't nest passages this deep.
const MAX_SCAN_DEPTH = 24;

module.exports = {
  project, tsOffsetToTwee, tweeOffsetToTs, tsRangeToTwee,
  TWEE_EXTENSIONS, TWEE_FILE_RE, isTweeFile, TWEE_GLOB, MAX_SCAN_DEPTH,
};
