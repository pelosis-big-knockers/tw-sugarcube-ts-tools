// Unit tests for the twee -> TypeScript projection and its position map.
//
// These run without tsserver. The projection's contract is that every emitted
// span maps back to text the author actually wrote — a diagnostic that lands on
// the wrong span is worse than no diagnostic, so mapping is tested directly
// rather than inferred from end-to-end behaviour.
import { createRequire } from "module";
import path from "path";
import { fileURLToPath } from "url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { project, tsOffsetToTwee, tweeOffsetToTs, tsRangeToTwee } =
  require(path.join(path.dirname(testDir), "ts-plugin", "twee.js"));

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}${ok || !detail ? "" : `\n        ${detail}`}`);
};
const eq = (name, actual, expected) =>
  check(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

console.log("twee projection\n");

// The scaffolding that terminates each emission (`;`, `) {}`) starts on its own
// line so a trailing `//` comment in the author's code can't swallow it; these
// helpers compare the projection with that layout noise collapsed.
//
// Each passage body is also wrapped in an opaque `if` block, so one passage's
// assignments can't narrow what the next one reads. These sources are single
// passages and are about what the macros project to, so the wrapper is stripped
// along with the layout noise; `PASSAGE_BLOCK` covers it directly.
const PASSAGE_OPEN = "if (0 as any) {";
const flat = (src) => {
  const ts = project(src).ts.trim().replace(/\s+/g, " ");
  if (ts === `${PASSAGE_OPEN} }`) return "";
  if (ts.startsWith(`${PASSAGE_OPEN} `) && ts.endsWith(" }")) {
    return ts.slice(PASSAGE_OPEN.length + 1, -2);
  }
  return ts;
};

// --- macro bodies become statements ---
eq("<<run>> projects its expression",
  flat("<<run setup.attack(3)>>"), "setup.attack(3) ;");
eq("<<= >> projects its expression",
  flat("<<= setup.name()>>"), "setup.name() ;");
eq("<<print>> projects its expression",
  flat("<<print setup.name()>>"), "setup.name() ;");

// --- sigils ---
eq("$var becomes State.variables",
  flat("<<run setup.hit($hp)>>"), "setup.hit(State.variables.hp) ;");
eq("_var becomes State.temporary",
  flat("<<run setup.hit(_scratch)>>"), "setup.hit(State.temporary.scratch) ;");
eq("<<set $hp to 10>> becomes an assignment",
  flat("<<set $hp to 10>>"), "State.variables.hp = 10 ;");
eq("<<set $hp = 10>> also works",
  flat("<<set $hp = 10>>"), "State.variables.hp = 10 ;");
eq("<<if>> becomes a condition",
  flat("<<if $hp gt 0>>"), "if ( State.variables.hp > 0 ) {}");

// --- conditional blocks -----------------------------------------------------
// A closed `<<if>>` guards a real TypeScript block, which is what makes the
// condition narrow the code inside it: `<<if $hp>>` means `$hp` is not null
// until the `<<else>>` / `<</if>>`.
eq("a closed <<if>> guards its body",
  flat("<<if $hp>><<run setup.hit($hp)>><</if>>"),
  "if ( State.variables.hp ) { setup.hit(State.variables.hp) ; }");
eq("<<elseif>> and <<else>> continue the chain",
  flat("<<if $a>><<run f()>><<elseif $b>><<run g()>><<else>><<run h()>><</if>>"),
  "if ( State.variables.a ) { f() ; } else if ( State.variables.b ) { g() ; } else { h() ; }");
eq("the <<endif>> spelling closes a block too",
  flat("<<if $a>><<run f()>><<endif>>"), "if ( State.variables.a ) { f() ; }");
eq("<<if>> blocks nest",
  flat("<<if $a>><<if $b>><<run f()>><</if>><</if>>"),
  "if ( State.variables.a ) { if ( State.variables.b ) { f() ; } }");
eq("<<unless>> guards the negated condition",
  flat("<<unless $a>><<run f()>><</unless>>"),
  "if (!( State.variables.a )) { f() ; }");
// Prose between the macros is part of the guarded body, so a naked sigil there
// is narrowed like everything else.
eq("prose inside a block stays inside it",
  flat("<<if $hp>>You have $hp left.<</if>>"),
  "if ( State.variables.hp ) { State.variables.hp; }");
// An empty condition is a SugarCube error, but the block still has to balance.
eq("an empty condition still opens a block",
  flat("<<if>><<run f()>><</if>>"), "if (0 as any ) { f() ; }");

// A block that isn't complete and properly nested keeps the old self-contained
// emission. An unbalanced brace would be a syntax error across the WHOLE
// projection, and a half-written chain is the normal state of a file being
// typed into.
eq("an unclosed <<if>> falls back to a self-contained condition",
  flat("<<if $a>><<run f()>>"), "if ( State.variables.a ) {} f() ;");
eq("a stray <</if>> emits nothing",
  flat("<<run f()>><</if>>"), "f() ;");
eq("a stray <<else>> emits nothing",
  flat("<<run f()>><<else>><<run g()>>"), "f() ; g() ;");
// Crossed markup: the `<</if>>` pairs with the `<<if>>`, and the `<<unless>>`
// it skipped past falls back rather than being closed by the wrong tag.
eq("crossed close tags fall back instead of pairing wrongly",
  flat("<<if $a>><<unless $b>><<run f()>><</if>>"),
  "if ( State.variables.a ) { if (!( State.variables.b )) {} f() ; }");

// Passages are separate blocks, so a chain can never span them: the `<</if>>`
// below belongs to no `<<if>>` at all.
{
  const ts = project(":: A\n<<if $a>>\n:: B\n<<run f()>>\n<</if>>\n").ts;
  check("a block never spans a passage header",
    /if \( State\.variables\.a\s*\) \{\}/.test(ts) && !/\} else/.test(ts), JSON.stringify(ts));
  const two = project(":: A\n<<set $hp to 1>>\n:: B\n<<run f($hp)>>\n").ts;
  // Each passage gets its own block, so an assignment in one can't narrow what
  // the next one reads (`<<set $item to null>>` in an init passage would
  // otherwise make every later `<<if $item>>` narrow to `never`).
  check("each passage is projected into its own block",
    (two.match(/if \(0 as any\) \{/g) || []).length === 2, JSON.stringify(two));
}

// SugarCube's word operators are not valid TypeScript; leaving them alone would
// report a syntax error on a perfectly good passage.
eq("word operators are translated",
  flat("<<if $hp gte 10 and $gold lt 5>>"),
  "if ( State.variables.hp >= 10 && State.variables.gold < 5 ) {}");
eq("'is'/'isnot' translate to strict equality",
  flat("<<if $a is 1 or $b isnot 2>>"),
  "if ( State.variables.a === 1 || State.variables.b !== 2 ) {}");
eq("a method named like an operator is left alone",
  flat("<<run setup.is(1)>>"), "setup.is(1) ;");
eq("operator words inside strings are left alone",
  flat(`<<run setup.say("this and that")>>`), `setup.say("this and that") ;`);

// --- things that must NOT be rewritten ---
eq("sigils inside strings are left alone",
  flat(`<<run setup.say("costs $5 to enter")>>`),
  `setup.say("costs $5 to enter") ;`);
eq("'to' inside a string is left alone",
  flat(`<<set $s to "go to town">>`),
  `State.variables.s = "go to town" ;`);
eq("a member named 'to' is not rewritten",
  flat("<<run setup.to()>>"), "setup.to() ;");
check("unknown macros are skipped entirely",
  flat("<<linkreplace 'Go'>><<mycustom arg>>") === "",
  JSON.stringify(project("<<linkreplace 'Go'>><<mycustom arg>>").ts));
check("an unterminated macro does not throw or emit garbage",
  flat("<<run setup.foo(") === "", JSON.stringify(project("<<run setup.foo(").ts));

// --- prose variables ---
eq("naked $var in prose is projected",
  flat("You have $gold coins."), "State.variables.gold;");
eq("dotted prose variable is projected",
  flat("Hello $player.name!"), "State.variables.player.name;");
check("a bare $ is not projected", flat("Costs $ 5") === "", "bare $ leaked");

// SugarCube interpolates temporary (`_`) variables in prose too.
eq("naked _temp in prose is projected",
  flat("Rolled _scratch this turn."), "State.temporary.scratch;");
eq("dotted prose temp variable is projected",
  flat("Name is _hero.name."), "State.temporary.hero.name;");
// ...but ordinary text with underscores must not be mistaken for a variable.
check("a mid-word underscore (snake_case) is not projected",
  flat("please call do_thing now") === "", "snake_case leaked");
check("double-underscore markup (__underline__) is not projected",
  flat("this is __important__ text") === "", "__markup__ leaked");
check("a bare _ is not projected", flat("a _ b") === "", "bare _ leaked");

// --- comments are inert ---
// A sigil or word operator inside a comment is the author's note, not code, so it
// must be copied verbatim rather than rewritten.
eq("a // line comment inside a macro is left verbatim",
  flat("<<run f($hp) // when $hp gt 0 and alive>>"),
  "f(State.variables.hp) // when $hp gt 0 and alive ;");
eq("a /* block comment */ inside a macro is left verbatim",
  flat("<<set $a to 1 /* not $b or $c */>>"),
  "State.variables.a = 1 /* not $b or $c */ ;");
eq("a >> inside a block comment does not close the macro early",
  flat("<<run f() /* a >> b */ + 1>>"), "f() /* a >> b */ + 1 ;");

// The scaffolding newline is what keeps a trailing line comment from swallowing
// the emitted `;` / `) {}` — the projection must stay VALID TypeScript, checked
// with the real parser rather than by string shape.
{
  const ts = require("typescript");
  const parsesClean = (src) => {
    const sf = ts.createSourceFile("p.ts", project(src).ts, ts.ScriptTarget.Latest, true);
    return (sf.parseDiagnostics || []).length === 0;
  };
  check("a trailing // comment in <<if>> still projects to valid TS",
    parsesClean("<<if $hp gt 0 // sanity check>>"), JSON.stringify(project("<<if $hp gt 0 // sanity check>>").ts));
  // Blocks are the one construct that can leave a brace open, and an unbalanced
  // brace is a syntax error over the WHOLE projection — which would bury every
  // real diagnostic in the file. Half-written and crossed markup is the normal
  // state of a file being typed into, so each shape has to stay parseable.
  for (const src of [
    "<<if $a>>", "<</if>>", "<<else>>", "<<elseif $a>>", "<<endif>>",
    "<<if $a>><<else>>", "<<if $a>><<else>><<else>><</if>>",
    "<<if $a>><</if>><</if>>", "<<if $a>><<if $b>><</if>>",
    "<<if $a>><<unless $b>><</if>><</unless>>",
    "<<unless $a>><</if>>", "<<if>><</if>>", "<<if $a>><<elseif>><</if>>",
    ":: A\n<<if $a>>\n:: B\n<</if>>", ":: A\n<<if $a>><</if>>\n:: B\n<<else>>",
    "<<if $a // c>><<run f()>><</if>>", "<<if $a>>text $b more<</if>>",
  ]) {
    check(`malformed block markup still parses: ${JSON.stringify(src)}`,
      parsesClean(src), JSON.stringify(project(src).ts));
  }
  check("a trailing // comment in <<run>> still projects to valid TS",
    parsesClean("<<run f($hp) // note>>"), JSON.stringify(project("<<run f($hp) // note>>").ts));
  // ASI hazard: without the newline'd `;`, `$a // note` followed by `($b + 1)`
  // parsed as a CALL of $a — a bogus "not callable" diagnostic on valid code.
  const asi = project("<<print $a // note>> <<print ($b + 1)>>").ts;
  const sf = ts.createSourceFile("p.ts", asi, ts.ScriptTarget.Latest, true);
  // Both emissions live in the passage block, so the count to make is of the
  // statements inside it.
  const body = sf.statements[0]?.thenStatement?.statements ?? [];
  check("a comment before a parenthesized statement does not merge them (ASI)",
    body.length === 2 && (sf.parseDiagnostics || []).length === 0,
    `${body.length} statement(s) in ${JSON.stringify(asi)}`);
}

// --- template literals ---
// SugarCube resolves sigils inside `${...}` substitutions, so they must be
// rewritten; the quoted text around them must stay untouched.
eq("a sigil inside a template substitution is rewritten",
  flat("<<run setup.log(`HP: ${$hp}`)>>"), "setup.log(`HP: ${State.variables.hp}`) ;");
eq("template text outside the substitution is left alone",
  flat("<<run setup.log(`costs $5 to enter`)>>"), "setup.log(`costs $5 to enter`) ;");
check("a nested template's substitution is rewritten too",
  project("<<run setup.log(`x ${ `y ${$hp}` } z`)>>").ts.includes("${State.variables.hp}"),
  JSON.stringify(project("<<run setup.log(`x ${ `y ${$hp}` } z`)>>").ts));
{
  const src = "<<run setup.log(`HP: ${$hp}`)>>";
  const { ts: out, segments } = project(src);
  const back = tsOffsetToTwee(segments, out.indexOf("State.variables.hp"));
  eq("a substitution sigil maps back onto its $", src[back], "$");
}

// --- quote-aware macro scanning ---
eq("a macro containing >> inside a string still closes correctly",
  flat(`<<run setup.say("a>>b")>>`), `setup.say("a>>b") ;`);
eq("a << inside a macro string does not restart the scan",
  flat(`<<print "a << b">>`), `"a << b" ;`);

// --- prose containing << must not derail macro scanning ---
// A stray `<<` used to open a bogus macro whose scan could swallow the next
// real macro (or, via an unpaired quote, run to end-of-text and drop every
// macro after it).
eq("a stray << directly before a real macro doesn't swallow it",
  flat("damage << armor. <<set $hp to 1>>"), "State.variables.hp = 1 ;");
eq("a stray << plus a later apostrophe doesn't kill the rest of the file",
  flat("damage << armor, don't panic. <<set $hp to 1>>"), "State.variables.hp = 1 ;");

// --- position mapping ---
{
  const src = "<<run setup.attack($hp)>>";
  const { ts, segments } = project(src);
  // "attack" in the TS output should map back to "attack" in the twee source.
  const tsAt = ts.indexOf("attack");
  const back = tsOffsetToTwee(segments, tsAt);
  eq("ts->twee maps an identifier to its source offset", back, src.indexOf("attack"));
  eq("...and the text there matches", src.slice(back, back + 6), "attack");

  // Round trip from the twee side.
  const fwd = tweeOffsetToTs(segments, src.indexOf("attack"));
  eq("twee->ts maps back to the same identifier", ts.slice(fwd, fwd + 6), "attack");

  // A rewritten sigil anchors to the sigil, not into neighbouring text.
  const hpTs = ts.indexOf("State.variables.hp");
  const hpBack = tsOffsetToTwee(segments, hpTs);
  eq("a rewritten sigil maps back onto the $", src[hpBack], "$");
}

// --- diagnostic range mapping ---
{
  const src = `:: Start\n<<run setup.attack('nope')>>\n`;
  const { ts, segments } = project(src);
  const argTs = ts.indexOf("'nope'");
  const range = tsRangeToTwee(segments, argTs, "'nope'".length);
  check("a diagnostic range maps onto the offending argument",
    !!range && src.slice(range.start, range.start + range.length) === "'nope'",
    range ? JSON.stringify(src.slice(range.start, range.start + range.length)) : "(no range)");
}

// --- ranges inside a rewritten sigil ---
// A rewritten segment has no per-character correspondence, so a TS range that
// begins and ends inside one has to map to the WHOLE source token. Taking the
// TypeScript length instead (`State.variables.hp` is 15 characters longer than
// `$hp`) made hovers stop short of the last character and diagnostics spill past
// the variable into the author's next words.
{
  const src = `<<set $fakePassage to "This is a fake passage.">>`;
  const { ts, segments } = project(src);
  const at = (needle, text) => {
    const start = ts.indexOf(needle);
    const r = tsRangeToTwee(segments, start, (text || needle).length);
    return r ? src.slice(r.start, r.start + r.length) : "(no range)";
  };
  // The member name alone — what quickinfo returns for a hover.
  eq("a hover span inside a sigil covers the whole sigil",
    at("fakePassage"), "$fakePassage");
  // The whole rewritten expression — what a diagnostic on the variable returns.
  eq("a diagnostic on the rewritten name covers the whole sigil",
    at("State.variables.fakePassage"), "$fakePassage");
}
{
  // `$test3` is possibly undefined: TS reports the range `State.variables.test3`,
  // 21 characters, which used to underline `$test3.property = "Th`.
  const src = `<<set $test3.property = "This is a test variable.">>`;
  const { ts, segments } = project(src);
  const start = ts.indexOf("State.variables.test3");
  const r = tsRangeToTwee(segments, start, "State.variables.test3".length);
  eq("a possibly-undefined diagnostic stops at the end of the sigil",
    src.slice(r.start, r.start + r.length), "$test3");
  // ...and a range that continues past the sigil still covers everything it spans.
  const whole = tsRangeToTwee(segments, start, ts.indexOf('"') + 26 - start);
  eq("a range spanning the sigil and the text after it covers both",
    src.slice(whole.start, whole.start + whole.length),
    `$test3.property = "This is a test variable."`);
}
{
  // The same collapse in prose, where the emission ends the projection: the
  // over-long range used to run off the end of the document.
  const src = "The test variable is $test3.";
  const { ts, segments } = project(src);
  const start = ts.indexOf("State.variables.test3");
  const r = tsRangeToTwee(segments, start, "State.variables.test3".length);
  eq("a prose sigil's range stops at the sigil, not past the document",
    src.slice(r.start, r.start + r.length), "$test3");
}
{
  // Hovering the sigil character itself must reach the member, not the `State`
  // that the preceding verbatim segment's boundary used to hand back.
  const src = "<<set $hp to 1>>";
  const { ts, segments } = project(src);
  const tsOffset = tweeOffsetToTs(segments, src.indexOf("$hp"));
  eq("hovering the $ itself lands on the member, not on State",
    ts.slice(tsOffset - "State.variables.hp".length, tsOffset), "State.variables.hp");
}

// --- multi-line realism ---
{
  const src = [
    ":: StoryTitle",
    "Spike",
    "",
    ":: Start",
    "<<set $hp to 100>>",
    "You have $hp health.",
    "<<= setup.playerName()>> attacks for <<= setup.attack($hp)>>.",
  ].join("\n");
  const { ts, segments } = project(src);
  // <<set>>, the prose $hp, and the two <<= >> calls — with each macro's `;`
  // scaffolding on its own line (prose emissions keep theirs inline).
  const statements = ts.trim().split("\n")
    .filter((l) => l.trim() && l.trim() !== ";" && l.trim() !== "}" && l.trim() !== PASSAGE_OPEN);
  eq("a realistic passage projects every JS site", statements.length, 4);
  check("title/prose text is not projected as code",
    !/StoryTitle|Spike|health/.test(ts), ts);
  // Every segment must point at real source text of the right shape.
  const bad = segments.filter((s) => s.tweeStart < 0 || s.tweeStart + s.tweeLength > src.length);
  check("every segment lies inside the source document", bad.length === 0, JSON.stringify(bad));
  // Verbatim segments must match character-for-character.
  const mismatched = segments.filter(
    (s) => s.tsLength === s.tweeLength &&
      ts.substr(s.tsStart, s.tsLength) !== src.substr(s.tweeStart, s.tweeLength)
  );
  check("verbatim segments match the source exactly", mismatched.length === 0,
    JSON.stringify(mismatched.slice(0, 3)));
}

// --- recognized file extensions --------------------------------------------
// tweego's Twee source set: .tw, .twee, and the Twee2 variants .tw2, .twee2.
check("all four tweego twee extensions are recognized",
  ["a.tw", "a.twee", "a.tw2", "a.twee2"].every((f) => project && require(
    path.join(path.dirname(testDir), "ts-plugin", "twee.js")).isTweeFile(f)));
check("non-twee extensions are not recognized",
  !["a.ts", "a.js", "a.twx", "a.tw3"].some((f) => require(
    path.join(path.dirname(testDir), "ts-plugin", "twee.js")).isTweeFile(f)));

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log("FAILED: " + failed.map((f) => f.name).join(", "));
  process.exit(1);
}
