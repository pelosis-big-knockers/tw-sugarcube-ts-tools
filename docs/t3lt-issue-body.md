# `findMacro` never settles when no widget matches — hangs Go to Definition for every extension

## Summary

`findMacro` returns a promise that is resolved only when a matching widget
definition is found. When nothing matches, it never settles.

Because VS Code aggregates definition providers with `Promise.all`, that one
pending promise prevents the aggregate from ever completing — so Go to
Definition, Ctrl+click and Peek Definition silently do nothing in `.twee` files,
including results contributed by _other_ extensions. There's no error, so it
looks like "no definition found".

The regex only matches widget definitions (`config.widgetAliases`), so every
built-in macro triggers it: `<<=`, `<<print>>`, `<<set>>`, `<<if>>`, `<<run>>`.

## Source

`src/sugarcube-2/macros.ts`:

```ts
return new Promise(searchDone => {
	files.map(file => {
		return vscode.workspace.fs.readFile(file)
			.then((c: Uint8Array) => {
				if (token.isCancellationRequested) return null;   // doesn't settle either
				const s = Buffer.from(c).toString("utf-8");
				const pos = s.match(regex);
				if (pos == null) return null;                     // <-- searchDone never called
				...
				return searchDone(new vscode.Location(file, new vscode.Position(lines, 0)));
			});
	});
});
```

## Reproduction

Workspace with a `.twee` file and a `.ts`/`.js` file:

```
:: Start
<<= setup.playerName()>>
```

Put the cursor on `playerName` and press F12 — nothing happens. Same for
Ctrl+click and Peek. Any extension registering a `DefinitionProvider` for the
document is affected, not just this one.

## Measurements

Run in a real extension host, each call wrapped in `Promise.race` with an 8s
timeout, document at `twee3-sugarcube-2`:

| condition                                             | `executeDefinitionProvider` / `revealDefinition` |
| ----------------------------------------------------- | ------------------------------------------------ |
| extension enabled                                     | hangs (no result in 8s)                          |
| extension disabled                                    | returns 1 result, navigates correctly            |
| same content saved as `.txt`, extension enabled       | returns normally                                 |
| `languageId` forced to `plaintext`, extension enabled | still hangs                                      |

The last two indicate the provider is registered by file pattern rather than by
language, so changing the language association isn't a workaround.

Patching the shipped bundle to resolve when nothing matches (`Promise.all` around
the file reads, then `resolve(null)`) makes both calls return and navigate, with
the extension otherwise fully enabled.

## Suggested fix

```ts
export const findMacro = async function (macro: string, token: vscode.CancellationToken): Promise<vscode.Definition | vscode.LocationLink[] | null> {
  if (!macro) return null;

  const files = await vscode.workspace.findFiles("**/*.{js,twee,tw}", "**/{node_modules,.git}/**");
  const config = vscode.workspace.getConfiguration("twee3LanguageTools.sugarcube-2");
  const regex = new RegExp(`(?:${config.widgetAliases.join("|")})(["']?)${macro}\\1(?:, )?`);

  const results = await Promise.all(
    files.map(async (file) => {
      if (token.isCancellationRequested) return null;
      let s: string;
      try {
        s = Buffer.from(await vscode.workspace.fs.readFile(file)).toString("utf-8");
      } catch {
        return null;
      }
      const pos = s.match(regex);
      if (pos == null) return null;
      const lines = s.substring(0, pos.index).match(/\n/g)?.length ?? 0;

      if (file.path.endsWith(".js")) {
        const result = await vscode.commands.executeCommand<vscode.Definition | vscode.LocationLink[] | null>(
          "vscode.executeDefinitionProvider",
          file,
          new vscode.Position(lines, pos[0].length + 1),
        );
        if (!result || (Array.isArray(result) && !result.length)) {
          return new vscode.Location(file, new vscode.Position(lines, pos[0].length));
        }
        return result;
      }
      return new vscode.Location(file, new vscode.Position(lines, 0));
    }),
  );

  return results.find((r) => r != null) ?? null;
};
```

This changes one behaviour: the original resolved with whichever file matched
first (a race), this resolves with the first match in scan order. If the race is
preferred, keeping the `new Promise` shape and adding
`Promise.all(...).then(() => searchDone(null))` also fixes it.

**Environment:** VS Code with bundled TypeScript 6.0.3, extension v0.34.0, Windows 11.
