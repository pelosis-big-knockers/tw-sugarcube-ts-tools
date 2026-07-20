# Twee 3 Language Tools: definition provider never resolves, breaking Go to Definition for every extension

**Affected:** `cyrusfirheir.twee3-language-tools` v0.34.0
**Impact:** Go to Definition, Ctrl+click and Peek Definition silently do nothing in any `.twee` file — not only for this extension, but for *every* extension that provides definitions there.

## Summary

The extension registers a `DefinitionProvider` whose `provideDefinition` never
settles for at least some positions. VS Code aggregates definition providers
with `Promise.all` (`getDefinitionsAtPosition` in
`vs/editor/contrib/gotoSymbol/browser/goToSymbol.ts`), so a single provider that
never resolves prevents the aggregate from ever completing. The editor receives
no results and shows no error, so the failure is invisible — it looks exactly
like "no definition found".

Registration is by **file pattern**, not language, so setting the document's
`languageId` to something else does not avoid it.

## Reproduction

Any workspace containing a `.twee` file plus a `.ts` file, e.g.

`story.twee`
```
:: Start
<<= setup.playerName()>> attacks for <<= setup.attack(3)>>.
```

`player.ts`
```ts
setup.playerName = () => "Hero";
```

Register any definition provider for the `.twee` document and query it:

```js
vscode.languages.registerDefinitionProvider(
  { scheme: "file", pattern: "**/*.{twee,tw}" },
  { provideDefinition: () => [new vscode.Location(someUri, someRange)] }
);

// never resolves while this extension is enabled
await vscode.commands.executeCommand("vscode.executeDefinitionProvider", tweeUri, position);
```

## Measurements

Run in a real extension host (`Code.exe --extensionDevelopmentPath=... --extensionTestsPath=...`),
each call wrapped in `Promise.race` with an 8s timeout. Position is on
`playerName` in `<<= setup.playerName()>>`.

| condition | `executeDefinitionProvider` / `editor.action.revealDefinition` |
| --- | --- |
| `.twee`, extension enabled | **hangs** (no result in 8s) |
| `.twee`, extension enabled, `languageId` forced to `plaintext` | **hangs** |
| identical content saved as `.txt`, extension enabled | returns normally |
| `.twee`, extension disabled | returns 1 result, navigates correctly |

With the extension enabled, four different provider registrations were tried —
pattern selector, language selector, language+scheme selector, and `"*"` — and
all four reported `provider called = true` followed by a hang. The provider
callbacks run; the aggregate never settles.

That the same content in a `.txt` file resolves normally, while forcing the
`.twee` document's language to `plaintext` does not help, indicates the
registration is scoped by file pattern.

## Root cause

`findMacro` in `src/sugarcube-2/macros.ts` builds a promise that is resolved
**only when a matching widget definition is found**:

```ts
return new Promise(searchDone => {
    files.map(file => {
        return vscode.workspace.fs.readFile(file)
            .then((c: Uint8Array) => {
                if (token.isCancellationRequested) return null;
                const s = Buffer.from(c).toString("utf-8");
                const pos = s.match(regex);
                if (pos == null) return null;          // <-- searchDone never called
                ...
                return searchDone(new vscode.Location(file, new vscode.Position(lines, 0)));
            });
    });
});
```

If no file matches, `searchDone` is never called and the promise never settles.
The regex only matches *widget definitions* (`config.widgetAliases`), so every
built-in macro — `<<=`, `<<print>>`, `<<set>>`, `<<if>>`, `<<run>>` — hangs. A
cancelled token returns `null` from the inner callback rather than resolving, so
cancellation doesn't settle it either.

## Suggested patch

```ts
export const findMacro = async function (
    macro: string,
    token: vscode.CancellationToken
): Promise<vscode.Definition | vscode.LocationLink[] | null> {
    if (!macro) return null;

    const files = await vscode.workspace.findFiles("**/*.{js,twee,tw}", "**/{node_modules,.git}/**");
    const config = vscode.workspace.getConfiguration("twee3LanguageTools.sugarcube-2");
    const regex = new RegExp(`(?:${config.widgetAliases.join("|")})(["']?)${macro}\\1(?:, )?`);

    const results = await Promise.all(files.map(async (file) => {
        if (token.isCancellationRequested) return null;
        let s: string;
        try {
            s = Buffer.from(await vscode.workspace.fs.readFile(file)).toString("utf-8");
        } catch {
            return null;               // an unreadable file must not sink the lookup
        }
        const pos = s.match(regex);
        if (pos == null) return null;
        const lines = s.substring(0, pos.index).match(/\n/g)?.length ?? 0;

        if (file.path.endsWith(".js")) {
            const result = await vscode.commands.executeCommand<vscode.Definition | vscode.LocationLink[] | null>(
                "vscode.executeDefinitionProvider", file, new vscode.Position(lines, pos[0].length + 1)
            );
            if (!result || (Array.isArray(result) && !result.length)) {
                return new vscode.Location(file, new vscode.Position(lines, pos[0].length));
            }
            return result;
        }
        return new vscode.Location(file, new vscode.Position(lines, 0));
    }));

    return results.find((r) => r != null) ?? null;   // ALWAYS settles
};
```

Behavioural note: the original resolved with whichever file matched *first* (a
race); this resolves with the first match in workspace-scan order, which is
deterministic. If the race is preferred, keep the `new Promise` shape and add
`Promise.all(...).then(() => searchDone(null))` so it still settles when nothing
matches.

## Verified

Patching the shipped bundle with the minimal equivalent (`Promise.all(...)`
around the file fan-out, then `resolve(null)`) and re-running the harness, with
the extension enabled and the document at `twee3-sugarcube-2`:

| build | `executeDefinitionProvider` | `editor.action.revealDefinition` |
| --- | --- | --- |
| unpatched | hangs | times out, no navigation |
| patched | 1 result | returns and navigates |

## Likely location

`out/extension.js` registers two definition providers:

```js
o.languages.registerDefinitionProvider(O, { provideDefinition: (t, n, r) => w.definition(e, t, n, r) })
o.languages.registerDefinitionProvider(j, { provideDefinition: (t, n, r) => w.definitionConfig(e, t, n, r) })
```

The neighbouring hover registration uses the same selector `O` and then filters
by `languageId` *inside* the callback, which is consistent with `O` being a
file-pattern selector.

## Suggested fix

Ensure `provideDefinition` always settles — return `null`/`[]` on paths where no
definition applies, and bound any awaited work (passage-name index build, file
scan, cache population) so a pending or failed dependency resolves rather than
hanging. Honouring the provided `CancellationToken` would also let VS Code
abandon the call instead of waiting forever.

## Workarounds for other extensions

Until this is fixed, extensions cannot deliver definitions in `.twee` files via
the normal mechanism. Two paths that do work:

- a `DocumentLinkProvider` (separate aggregation; VS Code renders and navigates
  links itself — but document links are always underlined), and
- a custom command bound to `F12` with a `when` clause on the file extension,
  bypassing the definition aggregation entirely.
