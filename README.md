# Twine SugarCube TypeScript Tools

A VS Code extension that makes SugarCube's assignment-populated containers
genuinely typed in TypeScript/JavaScript story code — with nothing to wire up per
file and no change to how you write:

```ts
setup.attack = (power: number): number => power * 2;   // define anywhere
setup.attack(5);        // -> number, ctrl+click jumps here, hover shows the signature
setup.attack('nope');   // -> Argument of type 'string' is not assignable to 'number'
State.variables.hp = 100;
const s: string = State.variables.hp;  // -> Type 'number' is not assignable to 'string'
State.variables.setInAPassage;         // -> any, no error (see below)
```

## What it does

The plugin scans your `.ts`/`.js` files for assignments to SugarCube's
author-facing containers — `setup`, `State.variables`, `State.temporary`, and
`settings` — recovers each member's **type** from its assignment, and feeds a
generated module augmentation into the project. TypeScript then types those
members natively, so you get:

- **real types on hover** — `(property) SugarCubeSetupObject["attack"]: (power: number) => number`
- **parameter and arity checking**
- **return types that flow** — `const dmg = setup.attack(5)` is `number`, not `any`
- **typed story variables**
- **completion**, and **go-to-definition redirected to the assignment** (not the
  generated declaration)

Because the members are genuinely declared, `keyof typeof setup` is meaningful —
useful for dynamic access: `const k: keyof typeof setup = "attack"; setup[k] = …`.

You need **no `.d.ts` in your project**. Engine globals (`State`, `Story`, `$`,
`Config`, …) come from [`@types/twine-sugarcube`](https://www.npmjs.com/package/@types/twine-sugarcube);
load them with `"types": ["twine-sugarcube"]` in your `tsconfig.json` (which is
what `tw-server init` writes).

Only `.ts`/`.js` files are covered. Intelligence inside `.twee` passages
(`<<run setup.foo()>>`, `<<set $hp to 10>>`) is planned separately.

## Members created outside TypeScript

Every container keeps an open index signature (`[key: string]: any`), because
members are routinely created where this plugin can't see them:

- `<<set $hp to 1>>` in a passage
- `Setting.addToggle(...)` creating a `settings` entry
- a computed `setup[someString] = …`

So reading a member that was never assigned in `.ts` gives you `any` rather than
an error. Members that *were* assigned still take precedence over the index
signature, so their types are checked as normal — you get typing where it's known
and quiet everywhere else.

The trade-off is that misspelling a member can't be reported (it just resolves to
`any`). Catching typos would require knowing every assignment site, including
passages — which is what the planned `.twee` support would provide.

If typing is ever wrong for your story, set **`twSugarcube.strict: false`** to drop
the recovered types entirely; completion and go-to-definition keep working.

## Why an extension (and not a tsconfig plugin)

VS Code does **not** reliably load a plugin listed in a project's `tsconfig.json`
from local `node_modules`. Extensions that contribute a `typescriptServerPlugins`
entry are loaded as **global** plugins into VS Code's TypeScript server — the same
mechanism the Svelte and Angular extensions use.

## How the generated types reach the project

Worth knowing before changing any of it:

- `getExternalFiles` registers the generated file with the project, which is what
  makes tsserver create a real `ScriptInfo` for it. **Adding a name to the host's
  `getScriptFileNames()` instead makes `ProjectService.setDocument` throw
  "Debug Failure" and crashes the language service.**
- The content is served from memory by patching `info.serverHost`; nothing is ever
  written to your workspace.
- tsserver's file watcher for that path is captured and fired on regeneration, so
  types refresh live as you edit.

## Development

```sh
npm install          # installs the bundled plugin, vsce, and test deps
npm test             # drives a REAL tsserver against test/fixture*
npm run package      # runs the smoke test, then produces the .vsix
```

`npm test` spawns an actual tsserver with the plugin loaded as a global plugin and
asserts on real diagnostics. A hand-rolled `ts.createLanguageService` host does
**not** represent tsserver — it has no `ProjectService`, so it silently accepts
things that crash the real server. Any change to file injection must be verified
by this test; `npm run package` will not build a `.vsix` unless it passes.

Install the `.vsix` via **Extensions: Install from VSIX…**, then reload.
