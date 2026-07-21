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

// Conditional macros that open a block, and the closing tags that end one.
// SugarCube accepts both the `<</if>>` and `<<endif>>` spellings.
const BLOCK_OPEN = new Set(["if", "unless"]);
const BLOCK_CLOSE = new Map([
  ["/if", "if"], ["endif", "if"], ["/unless", "unless"], ["endunless", "unless"],
]);

// A condition we can't project (an empty `<<if>>`) still has to open a block, or
// the chain's `<</if>>` would close something that was never opened. `any` keeps
// it from narrowing anything, and being raw scaffolding no diagnostic can land
// on it.
const OPAQUE_CONDITION = "0 as any";

// Passages are entered independently, in whatever order the story takes, so each
// one is projected into its own block. Control flow reaching the next passage
// merges the "previous passage ran" and "it didn't" paths, which restores every
// member's declared type: without this, a `<<set $item to null>>` in an init
// passage would narrow `$item` to `null` for every passage below it in the file
// — turning a later `<<if $item>>` into `never` and reporting a use of `$item`
// as a null argument.
const PASSAGE_OPEN = `if (${OPAQUE_CONDITION}) {\n`;
const PASSAGE_CLOSE = "\n}\n";

// `<<script>>` is the one macro whose payload is code rather than markup.
// SugarCube hands it straight to `Scripting.evalJavaScript`, which `eval`s it
// inside a function whose `this` is `{ output }` — so NOTHING in it is
// desugared: `_i` is a local variable, not `State.temporary.i`, and `to` is
// just a word. Projecting the body as prose (which is what happens when the
// macro isn't recognized) invents `State.temporary.*` members that the story
// never had. The one exception is `<<script TwineScript>>`, which routes
// through `evalTwineScript` and IS desugared.
//
// The body becomes a function expression of its own so it gets the scope
// isolation it has at runtime — two blocks may each declare `const x` — and so
// `this.output` doesn't read as `globalThis`. `this: any` rather than a real
// shape: the projection must never be the source of a diagnostic the author
// can't act on, and typing `output` would need the DOM lib to be loaded.
const SCRIPT_OPEN = "(function (this: any) {\n";
const SCRIPT_CLOSE = "\n});\n";

// `<<script>>`, optionally with the language argument SugarCube accepts.
const SCRIPT_OPEN_RE = /^\s*script(?![A-Za-z0-9_])/;
// SugarCube closes a container macro with either spelling.
const SCRIPT_CLOSE_RE = /<<\s*(?:\/script|endscript)\s*>>/;
// A passage header ends the passage's text, so it also ends an unclosed payload.
const PASSAGE_HEADER_RE = /(^|\n)::/;

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

// Skip a quoted string (or a template literal) that starts at `i`, returning the
// offset just past its closing quote, or -1 when it never closes.
function skipQuoted(text, i) {
  const quote = text[i];
  let j = i + 1;
  while (j < text.length) {
    if (text[j] === "\\") { j += 2; continue; }
    if (text[j] === quote) return j + 1;
    j++;
  }
  return -1;
}

// Whether a body is self-contained: brackets paired, and no string or comment
// left hanging open. A `<<script>>` payload is emitted verbatim, so a body that
// isn't would eat the scaffolding that closes the passage block — turning one
// half-typed script into a syntax error over the WHOLE projection and burying
// every real diagnostic in the file.
//
// Deliberately cheap and biased toward "no": a regex literal is read as code,
// so `/}/` reports unbalanced and the body is skipped. Losing diagnostics on
// one script block is recoverable; losing them on the file is not.
function isSelfContained(code) {
  const CLOSERS = { ")": "(", "]": "[", "}": "{" };
  const stack = [];
  let i = 0;
  while (i < code.length) {
    const c = code[i];
    if (c === '"' || c === "'" || c === "`") {
      i = skipQuoted(code, i);
      if (i === -1) return false;
      continue;
    }
    if (c === "/" && code[i + 1] === "/") {
      while (i < code.length && code[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && code[i + 1] === "*") {
      const end = code.indexOf("*/", i + 2);
      if (end === -1) return false;
      i = end + 2;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") stack.push(c);
    else if (CLOSERS[c] && stack.pop() !== CLOSERS[c]) return false;
    i++;
  }
  return stack.length === 0;
}

// Project a `<<script>>` payload. `lang` is the macro's language argument,
// lowercased; only `twinescript` desugars.
function emitScriptPayload(builder, text, script, lang) {
  const body = text.slice(script.bodyStart, script.bodyEnd);
  if (!body.trim() || !isSelfContained(body)) return;
  builder.raw(SCRIPT_OPEN);
  if (lang === "twinescript") {
    emitExpression(builder, body, script.bodyStart, { allowTo: true });
  } else {
    // Plain JavaScript (and TypeScript, which tw-server strips before tweego
    // ever sees it) is already what the projection speaks — copy it through.
    builder.verbatim(body, script.bodyStart);
  }
  builder.raw(SCRIPT_CLOSE);
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
    const macro = { start: open, end: close + 2, inner: text.slice(open + 2, close) };
    // A `<<script>>` payload is code, not markup: a `<<` in it (`a << b`) is a
    // shift, not a macro, and its `<</script>>` is not a stray closing tag. The
    // whole region becomes one macro so everything inside is skipped at once.
    const script = SCRIPT_OPEN_RE.test(macro.inner) ? findScriptPayload(text, macro.end) : null;
    if (script) {
      macro.script = script;
      macro.end = script.end;
    }
    out.push(macro);
    i = macro.end;
  }
  return out;
}

// Locate the payload of a `<<script>>` opened just before `from`. Returns null
// when it isn't closed inside its own passage — an unclosed payload is the
// normal state of a file being typed into, and swallowing the rest of the
// document would drop every macro after it.
function findScriptPayload(text, from) {
  const rest = text.slice(from);
  const match = SCRIPT_CLOSE_RE.exec(rest);
  if (!match) return null;
  if (PASSAGE_HEADER_RE.test(rest.slice(0, match.index))) return null;
  return { bodyStart: from, bodyEnd: from + match.index, end: from + match.index + match[0].length };
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
  // A closing tag: the `/` is part of the name, so `<</if>>` is distinguishable
  // from the `<<if>>` it closes.
  const slash = inner[k] === "/" ? 1 : 0;
  let e = k + slash;
  while (e < inner.length && /[A-Za-z0-9_]/.test(inner[e])) e++;
  return { name: inner.slice(k, e), argStart: innerBase + e, arg: inner.slice(e) };
}

// The offsets of the `::` passage headers, which are the boundaries between
// passages: a header is a `::` at the start of a line. A `::` inside a macro
// body isn't one — splitting a macro in half there would emit half a statement.
function passageStarts(text, macros) {
  const out = [];
  for (let i = 0; i < text.length - 1; i++) {
    if (text[i] !== ":" || text[i + 1] !== ":") continue;
    if (i > 0 && text[i - 1] !== "\n") continue;
    if (macros.some((m) => i > m.start && i < m.end)) continue;
    out.push(i);
    i++;
  }
  return out;
}

/**
 * Pair each `<<if>>` / `<<unless>>` with its `<<elseif>>`, `<<else>>` and
 * closing tag, so a whole chain can be projected as real TypeScript control
 * flow and the condition narrows the code it guards.
 *
 * Only complete, properly nested chains that stay inside one passage qualify.
 * Everything else keeps the self-contained `if (...) {}` emission: an
 * unbalanced brace is a syntax error that takes down the projection of the
 * WHOLE file, which is a far worse failure than a missing narrowing — and a
 * half-written chain is the normal state of a file being typed into.
 *
 * @returns Map of macro index -> "open" | "elseif" | "else" | "close"
 */
function pairBlocks(macros, parts, boundaries) {
  const roles = new Map();
  const stack = [];
  let b = 0;
  for (let i = 0; i < macros.length; i++) {
    // A passage header abandons whatever is open: a block never spans passages,
    // and a stray `<<if>>` must not swallow the next passage's `<</if>>`.
    while (b < boundaries.length && boundaries[b] <= macros[i].start) { stack.length = 0; b++; }
    const part = parts[i];
    if (!part) continue;
    const name = part.name;
    if (BLOCK_OPEN.has(name)) {
      stack.push({ open: i, kind: name, branches: [], closed: false });
      continue;
    }
    if (name === "else" || name === "elseif") {
      // Everything after an `<<else>>` is malformed markup — a second `else`
      // would emit `else {} else {}` — so the chain stops taking branches
      // there and the extras fall back.
      const frame = stack[stack.length - 1];
      if (frame && !frame.closed) {
        frame.branches.push(i);
        if (name === "else") frame.closed = true;
      }
      continue;
    }
    const closes = BLOCK_CLOSE.get(name);
    if (!closes) continue;
    // A mismatched close (`<</if>>` while an `<<unless>>` is innermost) means
    // the markup is crossed; drop the frames it skipped so they fall back
    // rather than pairing a close with the wrong open.
    while (stack.length && stack[stack.length - 1].kind !== closes) stack.pop();
    if (!stack.length) continue;
    const frame = stack.pop();
    roles.set(frame.open, "open");
    for (const idx of frame.branches) roles.set(idx, parts[idx].name);
    roles.set(i, "close");
  }
  return roles;
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
  const allParts = macros.map((m) => splitMacro(m.inner, m.start + 2));
  const boundaries = passageStarts(text, macros);
  const roles = pairBlocks(macros, allParts, boundaries);

  let cursor = 0;
  let boundary = 0;
  let passageOpen = false;
  const openPassage = () => { builder.raw(PASSAGE_OPEN); passageOpen = true; };
  const closePassage = () => { if (passageOpen) { builder.raw(PASSAGE_CLOSE); passageOpen = false; } };
  // A file that opens with a header has no text before it — don't emit an empty
  // block for the nothing in front of the first passage.
  if (!boundaries.length || boundaries[0] > 0) openPassage();

  // Advance to `offset`, projecting the prose (and crossing any passage
  // boundary) in between. Paired blocks never span a boundary, so nothing of
  // ours is open when a passage block closes.
  const advanceTo = (offset) => {
    while (boundary < boundaries.length && boundaries[boundary] <= offset) {
      const at = boundaries[boundary++];
      if (at > cursor) { emitProseVariables(builder, text, 0, cursor, at); cursor = at; }
      closePassage();
      openPassage();
    }
    if (offset > cursor) { emitProseVariables(builder, text, 0, cursor, offset); cursor = offset; }
  };

  for (let i = 0; i < macros.length; i++) {
    const macro = macros[i];
    advanceTo(macro.start);
    cursor = macro.end;

    const parts = allParts[i];
    if (!parts) continue;
    const { name, arg, argStart } = parts;
    const role = roles.get(i);

    // The scaffolding that closes each emission starts on its own line: the
    // argument may end in a `//` comment, which would otherwise swallow the
    // `;` / `) {}` and leave the projection syntactically broken.
    if (macro.script) {
      emitScriptPayload(builder, text, macro.script, arg.trim().toLowerCase());
    } else if (role === "close") {
      builder.raw("\n}\n");
    } else if (role === "else") {
      builder.raw("\n} else {\n");
    } else if (role === "open" || role === "elseif") {
      // A paired conditional guards a real block, so its body is narrowed by
      // the condition — and by its negation in the `<<else>>`.
      const negate = role === "open" && name === "unless";
      builder.raw(role === "elseif" ? "\n} else if (" : "if (");
      if (!arg.trim()) {
        builder.raw(`${OPAQUE_CONDITION}\n) {\n`);
      } else {
        if (negate) builder.raw("!(");
        emitExpression(builder, arg, argStart, { allowTo: false });
        builder.raw(negate ? "\n)) {\n" : "\n) {\n");
      }
    } else if (EXPRESSION_MACROS.has(name)) {
      if (!arg.trim()) continue;
      emitExpression(builder, arg, argStart, { allowTo: false });
      builder.raw("\n;\n");
    } else if (CONDITION_MACROS.has(name)) {
      // Unpaired: the condition is still checked, but it guards nothing, so the
      // emission has to be self-contained.
      if (!arg.trim()) continue;
      const negate = name === "unless";
      builder.raw(negate ? "if (!(" : "if (");
      emitExpression(builder, arg, argStart, { allowTo: false });
      builder.raw(negate ? "\n)) {}\n" : "\n) {}\n");
    } else if (name === "set") {
      if (!arg.trim()) continue;
      emitExpression(builder, arg, argStart, { allowTo: true });
      builder.raw("\n;\n");
    }
    // Unknown/user-defined macros: their arguments are SugarCube's own
    // argument grammar (bare words, links), not JavaScript. Projecting them
    // would invent errors, so they're skipped.
  }
  advanceTo(text.length);
  closePassage();

  return { ts: builder.ts, segments: builder.segments };
}

// --- position mapping -------------------------------------------------------

// Find the segment covering an offset in one of the two documents. Adjacent
// segments share a boundary offset, so which one wins depends on what is being
// measured: the START of a range opens the following segment, the END of a range
// closes the preceding one. Getting that backwards is invisible for verbatim
// text (both sides agree character-for-character) but wrong for a rewritten
// segment, where every interior offset collapses to one endpoint.
function findSegment(segments, offset, key, atEnd) {
  const startKey = key === "ts" ? "tsStart" : "tweeStart";
  const lengthKey = key === "ts" ? "tsLength" : "tweeLength";
  let boundary = null;
  for (const s of segments) {
    const from = s[startKey];
    const to = from + s[lengthKey];
    if (offset < from || offset > to) continue;
    if (atEnd ? offset > from : offset < to) return s;
    // Only touching this segment's far edge: usable, but keep looking for one
    // the offset is genuinely inside.
    if (boundary === null) boundary = s;
  }
  return boundary;
}

function tsOffsetToTwee(segments, offset) {
  const s = findSegment(segments, offset, "ts", false);
  if (!s) return null;
  // Exact correspondence when the text wasn't rewritten.
  if (s.tsLength === s.tweeLength) return s.tweeStart + (offset - s.tsStart);
  return s.tweeStart;
}

// The same map for the END of a TS range. Inside a rewritten segment there is no
// per-character correspondence, so an interior offset collapses to an endpoint —
// and the end of a range has to collapse to the END of the source token, past
// the `p` of `$hp`. Collapsing it to the start (and then taking the TypeScript
// length as the twee length) is what made a diagnostic on
// `State.variables.test3` underline `$test3.property = "Th`.
function tsOffsetToTweeEnd(segments, offset) {
  const s = findSegment(segments, offset, "ts", true);
  if (!s) return null;
  if (s.tsLength === s.tweeLength) return s.tweeStart + (offset - s.tsStart);
  return s.tweeStart + s.tweeLength;
}

function tweeOffsetToTs(segments, offset) {
  const s = findSegment(segments, offset, "twee", false);
  if (!s) return null;
  if (s.tsLength === s.tweeLength) return s.tsStart + (offset - s.tweeStart);
  // Rewritten: aim at the end of the emitted text, which is the member name
  // (`State.variables.hp` <- `$hp`), so hover lands on the property.
  return s.tsStart + s.tsLength;
}

// Map a TS range back to a twee range, for diagnostics and hover spans.
function tsRangeToTwee(segments, start, length) {
  const from = tsOffsetToTwee(segments, start);
  if (from === null) return null;
  let to = tsOffsetToTweeEnd(segments, start + length);
  if (to === null || to <= from) {
    // The range ends in scaffolding that has no source counterpart. Clamp to the
    // source span of the segment it starts in: a twee length is never allowed to
    // come from a TypeScript length, or the highlight runs past the token into
    // whatever the author wrote next.
    const s = findSegment(segments, start, "ts", false);
    const limit = s ? s.tweeStart + s.tweeLength : from + length;
    to = Math.min(from + length, limit);
  }
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
