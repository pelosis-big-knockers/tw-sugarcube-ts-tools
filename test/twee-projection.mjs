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
const flat = (src) => project(src).ts.trim().replace(/\s+/g, " ");

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
  project("<<linkreplace 'Go'>><<mycustom arg>>").ts.trim() === "",
  JSON.stringify(project("<<linkreplace 'Go'>><<mycustom arg>>").ts));
check("an unterminated macro does not throw or emit garbage",
  project("<<run setup.foo(").ts.trim() === "", JSON.stringify(project("<<run setup.foo(").ts));

// --- prose variables ---
eq("naked $var in prose is projected",
  project("You have $gold coins.").ts.trim(), "State.variables.gold;");
eq("dotted prose variable is projected",
  project("Hello $player.name!").ts.trim(), "State.variables.player.name;");
check("a bare $ is not projected", project("Costs $ 5").ts.trim() === "", "bare $ leaked");

// SugarCube interpolates temporary (`_`) variables in prose too.
eq("naked _temp in prose is projected",
  project("Rolled _scratch this turn.").ts.trim(), "State.temporary.scratch;");
eq("dotted prose temp variable is projected",
  project("Name is _hero.name.").ts.trim(), "State.temporary.hero.name;");
// ...but ordinary text with underscores must not be mistaken for a variable.
check("a mid-word underscore (snake_case) is not projected",
  project("please call do_thing now").ts.trim() === "", "snake_case leaked");
check("double-underscore markup (__underline__) is not projected",
  project("this is __important__ text").ts.trim() === "", "__markup__ leaked");
check("a bare _ is not projected", project("a _ b").ts.trim() === "", "bare _ leaked");

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
  check("a trailing // comment in <<run>> still projects to valid TS",
    parsesClean("<<run f($hp) // note>>"), JSON.stringify(project("<<run f($hp) // note>>").ts));
  // ASI hazard: without the newline'd `;`, `$a // note` followed by `($b + 1)`
  // parsed as a CALL of $a — a bogus "not callable" diagnostic on valid code.
  const asi = project("<<print $a // note>> <<print ($b + 1)>>").ts;
  const sf = ts.createSourceFile("p.ts", asi, ts.ScriptTarget.Latest, true);
  check("a comment before a parenthesized statement does not merge them (ASI)",
    sf.statements.length === 2 && (sf.parseDiagnostics || []).length === 0,
    `${sf.statements.length} statement(s) in ${JSON.stringify(asi)}`);
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
  const statements = ts.trim().split("\n").filter((l) => l.trim() && l.trim() !== ";");
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
