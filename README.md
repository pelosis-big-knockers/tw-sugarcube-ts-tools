# Twine SugarCube TypeScript Tools

A VS Code extension that gives editor intelligence for SugarCube's
assignment-populated containers in TypeScript/JavaScript story code — completion,
go-to-definition, and no spurious "property does not exist" errors — for the plain
idiom, with nothing to wire up per file:

```ts
setup.playerName = (): string => State.variables.name; // define anywhere
setup.playerName();          // completes, ctrl+click jumps here, no red squiggle
State.variables.hp = 10;     // story variables, temp variables, and settings
State.variables.hp;          // all get the same treatment
```

## Why an extension (and not just a tsconfig plugin)

`setup.foo = …` attaches members by assignment, which TypeScript's type system
can't see. A language-service plugin can supply that knowledge — but VS Code does
**not** reliably load a plugin listed in a project's `tsconfig.json` from local
`node_modules` (a long-standing limitation). Extensions that contribute a
`typescriptServerPlugins` entry, however, are loaded as **global** plugins into
VS Code's TypeScript server — the same reliable mechanism the Svelte and Angular
extensions use. This extension is that thin wrapper around the plugin.

## What it does

The plugin (in `ts-plugin/`) scans your `.ts`/`.js` files for assignments to
SugarCube's author-facing containers — `setup`, `State.variables`,
`State.temporary`, and `settings` — and, for any member of them:

- lists every member as a **completion** after `setup.`, `State.variables.`, etc.,
- resolves **go-to-definition** to the assignment site(s), and
- **suppresses** the "property does not exist" error.

Because the errors are suppressed, you need **no permissive index-signature
`.d.ts`** in your project. Engine globals (`State`, `Story`, `$`, `Config`, …)
come from [`@types/twine-sugarcube`](https://www.npmjs.com/package/@types/twine-sugarcube);
load them with just `"types": ["twine-sugarcube"]` in your project's
`tsconfig.json` (which is what `tw-server init` writes).

Only `.ts`/`.js` files are covered. Intelligence inside `.twee` passages
(`<<run setup.foo()>>`, `<<set $hp to 10>>`) is planned separately.

## Development

```sh
npm install          # installs the bundled plugin + vsce
npm run package      # produces tw-sugarcube-ts-tools-<version>.vsix
```

Install the `.vsix` via **Extensions: Install from VSIX…** in VS Code, then reload.
