# Twine SugarCube TypeScript Tools

Makes SugarCube's assignment-populated containers genuinely typed — in
TypeScript/JavaScript story code **and inside `.twee` passages** — with nothing to
wire up per file and no change to how you write:

```ts
setup.attack = (power: number): number => power * 2;   // define anywhere
setup.attack(5);        // -> number, ctrl+click jumps here, hover shows the signature
setup.attack('nope');   // -> Argument of type 'string' is not assignable to 'number'
State.variables.hp = 100;
const s: string = State.variables.hp;  // -> Type 'number' is not assignable to 'string'
State.variables.setInAPassage;         // -> any, no error (see below)
```

```
:: Combat
<<set $hp to 100>>
<<run setup.attack($hp)>>            <-- $hp is a number, setup.attack is checked
<<run setup.attack("nope")>>         <-- Argument of type 'string' is not assignable
```

## What it does

The plugin scans your `.ts`/`.js` files **and the code embedded in `.twee`
passages** for assignments to SugarCube's author-facing containers — `setup`,
`State.variables`, `State.temporary`, and `settings` — recovers each member's
**type** from its assignment, and feeds a generated module augmentation into the
project. TypeScript then types those members natively, so you get:

- **real types on hover** — `(property) SugarCubeSetupObject.attack: (power: number) => number`
- **parameter and arity checking**
- **return types that flow** — `const dmg = setup.attack(5)` is `number`, not `any`
- **typed story variables**, including those created only by `<<set $hp to 10>>`
- **completion**, and **go-to-definition redirected to the assignment** (a `<<set>>`
  in a passage, or the `setup.x =` in your source — never the generated declaration)

Because the members are genuinely declared, `keyof typeof setup` is meaningful —
useful for dynamic access: `const k: keyof typeof setup = "attack"; setup[k] = …`.

A container shortened into a local counts as the container itself, so the common
shorthand is understood:

```ts
setup.setupPlayer = () => {
  const sv = State.variables;
  sv.name = "Hero";   // same as State.variables.name = "Hero"
  sv.hp = 100;
};
```

The alias must be `const` (a `let` can be pointed at a different object further
down, and its members would then be filed under the container by mistake).
Aliases chain, may be `export`ed from a shared module, and a nested binding that
happens to reuse the name correctly shadows the alias.

You need **no `.d.ts` in your project**. Engine globals (`State`, `Story`, `$`,
`Config`, …) come from [`@types/twine-sugarcube`](https://www.npmjs.com/package/@types/twine-sugarcube);
load them with `"types": ["twine-sugarcube"]` in your `tsconfig.json`.

## Passages (`.tw`, `.twee`, `.tw2`, `.twee2`)

All four Twee source extensions tweego recognizes are covered. Inside passages you
get hover, completion, go-to-definition, and diagnostics for
`setup`/variable members in macro code — `<<= >>`, `<<print>>`, `<<run>>`,
`<<set>>`, `<<if>>`, `<<script>>`, sigils (`$hp`, `_scratch`), and SugarCube's
word operators (`gt`, `is`, `and`, …). A `<<set $hp to 10>>` types the variable everywhere,
including in `.ts` files that read it. Passages update **live** — you don't have
to save first; the unsaved buffer is pushed to the language service as you type.

### `<<script>>` is code, not markup

SugarCube hands a `<<script>>` payload straight to `eval`, so none of
TwineScript's sugar applies inside it: `_i` is an ordinary local variable, `$el`
is an ordinary identifier, and `to` is just a word. The payload is analyzed as
what it is — real code, checked, with hover and go-to-definition, and with the
members it assigns recovered like any other assignment:

```
:: Start
<<script>>
  let count = 0;
  for (const hit of setup.rolls()) count += hit;
  State.variables.gold = count;   <-- $gold is a number everywhere after this
<</script>>
```

Payloads may be written in **TypeScript**. They're checked as TypeScript here,
and [`tw-server`](https://github.com/pelosis-big-knockers/tw-server) strips the
types out before tweego sees the file, exactly as it does for `.ts` sources —
so annotations, `as`, `satisfies` and the rest are available in a passage:

```
<<script>>
  const boost: number = setup.attack(2) satisfies number;
  State.variables.hp += boost;
<</script>>
```

Building with bare tweego instead would ship those types to the browser, where
they are a syntax error — the type stripping is what makes them safe, so a
TypeScript payload needs tw-server (or an equivalent step) in the build.

`<<script TwineScript>>`, the one payload SugarCube *does* desugar, keeps the
sigil rewriting. A payload that isn't closed, or whose brackets don't balance
yet, is left alone until it is: half-written code is the normal state of a file
being edited, and one unbalanced brace would otherwise report errors across the
whole file.

### Narrowing in `<<if>>`

A closed `<<if>>` narrows what it guards, exactly as the equivalent `if` would
in TypeScript — so a variable that is only sometimes set can be used inside the
check without complaint, and is still checked outside it:

```
:: Shop
<<if $item>>
  <<run setup.equip($item)>>     <-- $item is Item here, not Item | null
<<else>>
  <<run setup.equip($item)>>     <-- and null here, so this is an error
<</if>>
<<run setup.equip($item)>>       <-- unguarded: an error
```

`<<elseif>>`, `<<else>>`, `<<unless>>` and the `<<endif>>` spelling are all
understood, blocks nest, and a type test narrows too —
`<<if typeof $mix is "number">>` gives you a number inside. A chain that isn't
closed still type-checks its condition; it just doesn't narrow anything.

Each passage is narrowed on its own, because passages don't run in file order:
a `<<set $item to null>>` in an init passage doesn't make `$item` null for
every passage below it in the file.

Two features are workarounds for a bug in **Twee 3 Language Tools ≤ 0.34.0**,
whose definition provider never resolves and blocks native ctrl+click for *every*
extension in `.twee` files (see `docs/twee3-language-tools-definition-hang.md`).
Both default **off**:

- **`twSugarcube.passageLinks`** — makes members ctrl+clickable as document links.
  VS Code always underlines document links, so leave it off unless you need the
  gesture and can't fix Twee 3 Language Tools.
- **`twSugarcube.passageGoToDefinition`** — binds F12 in passages to this
  extension's own go-to-definition, bypassing the aggregation the bug hangs.

With a fixed Twee 3 Language Tools, native F12/ctrl+click work and neither is
needed.

## Members created outside TypeScript

Every container keeps an open index signature (`[key: string]: any`), because
members are routinely created where this plugin can't see them:

- a `settings` entry from `Setting.addToggle(...)`
- a computed `setup[someString] = …` or `Object.assign(setup, …)`
- an assignment in a `.js` file outside the TypeScript project

So reading a member that was never assigned gives you `any` rather than an error.
Members that *were* assigned still take precedence over the index signature, so
their types are checked as normal — you get typing where it's known and quiet
everywhere else.

If typing is ever wrong for your story, set **`twSugarcube.strict: false`** to drop
the recovered types entirely; completion and go-to-definition keep working.

### Typo detection (opt-in)

Set **`twSugarcube.typoDetection: true`** (requires `strict`) to close the
containers, so a member that was never assigned anywhere becomes an error:

```ts
setup.attck(1);   // -> Property 'attck' does not exist. Did you mean 'attack'?
```

This is off by default because it's only sound when every member is created by an
assignment the plugin can see. `settings` is never closed (its members come from
the Setting API), and any `Object.assign` / computed assignment reopens its
container — so a story that populates members dynamically will report false
positives. Turn it on only if you assign `setup`/variable members by plain
assignment or `<<set>>`.

## Command-line linter

`tw-sugarcube-lint` runs the same analysis over a whole project, for a pre-commit
hook or CI:

```sh
npx tw-sugarcube-lint .            # type-check .ts/.js and passage code
npx tw-sugarcube-lint . --typos    # + report never-assigned members
npx tw-sugarcube-lint . --json     # machine-readable
```

It builds a program from your `tsconfig.json`, checks passage code the same way
the editor does, and maps errors back onto `.twee` spans. Exit code is **0** when
clean, **1** on findings, **2** if the linter itself couldn't run — so CI just
checks the exit code. It shares the exact analysis core the editor uses, so the
two can't disagree.

The linter needs the JavaScript compiler API, which the **native TypeScript 7.x**
compiler does not expose. If your project is on 7.x, it falls back to the
TypeScript bundled with this tool (a 6.x line) and says so; the analysis is
unaffected.

## Why an extension (and not a tsconfig plugin)

VS Code does **not** reliably load a plugin listed in a project's `tsconfig.json`
from local `node_modules`. Extensions that contribute a `typescriptServerPlugins`
entry are loaded as **global** plugins into VS Code's TypeScript server — the same
mechanism the Svelte and Angular extensions use.

## How the generated types reach the project

Worth knowing before changing any of it — each point below was established by
driving a real tsserver, and the reasoning is in the code comments:

- `getExternalFiles` registers the generated file (and each passage projection)
  with the project, which is what makes tsserver create a real `ScriptInfo`.
  **Adding a name to the host's `getScriptFileNames()` instead makes
  `ProjectService.setDocument` throw "Debug Failure" and crashes the language
  service.**
- Content is served from memory by patching `info.serverHost`; nothing is ever
  written to your workspace.
- Content is generated **eagerly in `create()`**, because the file is read before
  the first language-service call.
- Regeneration is published by reloading the `ScriptInfo` and marking the project
  dirty. tsserver never fires a watcher for these paths on its own (there's no file
  on disk to observe), so that is the only delivery mechanism — a captured
  `watchFile` callback added nothing but a race against other global plugins.

## Development

```sh
npm install          # installs the bundled plugin, vsce, and test deps
npm test             # projection unit tests, transport tests, real-tsserver
                     #   smoke tests, and the CLI tests
npm run package      # runs the tests, then produces the .vsix
```

The smoke test spawns an actual tsserver — the same TypeScript version VS Code
bundles — with the plugin loaded as a global plugin (alongside decoy plugins,
since ordering bugs only appear with more than one loaded) and asserts on real
diagnostics. A hand-rolled `ts.createLanguageService` host does **not** represent
tsserver: it has no `ProjectService`, so it silently accepts things that crash the
real server. Any change to file injection must be verified by this test;
`npm run package` will not build a `.vsix` unless everything passes.

Install the `.vsix` via **Extensions: Install from VSIX…**, then reload.
```
