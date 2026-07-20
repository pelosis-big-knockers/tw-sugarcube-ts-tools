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

// --- macro bodies become statements ---
eq("<<run>> projects its expression",
  project("<<run setup.attack(3)>>").ts.trim(), "setup.attack(3);");
eq("<<= >> projects its expression",
  project("<<= setup.name()>>").ts.trim(), "setup.name();");
eq("<<print>> projects its expression",
  project("<<print setup.name()>>").ts.trim(), "setup.name();");

// --- sigils ---
eq("$var becomes State.variables",
  project("<<run setup.hit($hp)>>").ts.trim(), "setup.hit(State.variables.hp);");
eq("_var becomes State.temporary",
  project("<<run setup.hit(_scratch)>>").ts.trim(), "setup.hit(State.temporary.scratch);");
eq("<<set $hp to 10>> becomes an assignment",
  project("<<set $hp to 10>>").ts.trim(), "State.variables.hp = 10;");
eq("<<set $hp = 10>> also works",
  project("<<set $hp = 10>>").ts.trim(), "State.variables.hp = 10;");
eq("<<if>> becomes a condition",
  project("<<if $hp gt 0>>").ts.trim().replace(/\s+/g, " "), "if ( State.variables.hp > 0) {}");

// SugarCube's word operators are not valid TypeScript; leaving them alone would
// report a syntax error on a perfectly good passage.
eq("word operators are translated",
  project("<<if $hp gte 10 and $gold lt 5>>").ts.trim().replace(/\s+/g, " "),
  "if ( State.variables.hp >= 10 && State.variables.gold < 5) {}");
eq("'is'/'isnot' translate to strict equality",
  project("<<if $a is 1 or $b isnot 2>>").ts.trim().replace(/\s+/g, " "),
  "if ( State.variables.a === 1 || State.variables.b !== 2) {}");
eq("a method named like an operator is left alone",
  project("<<run setup.is(1)>>").ts.trim(), "setup.is(1);");
eq("operator words inside strings are left alone",
  project(`<<run setup.say("this and that")>>`).ts.trim(), `setup.say("this and that");`);

// --- things that must NOT be rewritten ---
eq("sigils inside strings are left alone",
  project(`<<run setup.say("costs $5 to enter")>>`).ts.trim(),
  `setup.say("costs $5 to enter");`);
eq("'to' inside a string is left alone",
  project(`<<set $s to "go to town">>`).ts.trim(),
  `State.variables.s = "go to town";`);
eq("a member named 'to' is not rewritten",
  project("<<run setup.to()>>").ts.trim(), "setup.to();");
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

// --- quote-aware macro scanning ---
eq("a macro containing >> inside a string still closes correctly",
  project(`<<run setup.say("a>>b")>>`).ts.trim(), `setup.say("a>>b");`);

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
  const lines = ts.trim().split("\n");
  // <<set>>, the prose $hp, and the two <<= >> calls.
  eq("a realistic passage projects every JS site", lines.length, 4);
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
