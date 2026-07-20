// Copy the language-service plugin into node_modules under its package name so
// (1) VS Code can resolve it for `contributes.typescriptServerPlugins`, and
// (2) vsce bundles it into the .vsix. A plain `file:` dependency would symlink it,
// which vsce can't package — so we copy instead.
import { cpSync, mkdirSync, rmSync, lstatSync, unlinkSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dest = path.join(root, "node_modules", "tw-sugarcube-ts-plugin");

mkdirSync(path.join(root, "node_modules"), { recursive: true });
// lstat, not existsSync: existsSync FOLLOWS symlinks, so a dangling leftover
// `file:`-dependency link reads as "nothing there", skips this cleanup, and
// crashes cpSync below — the very case the symlink branch exists for.
const existing = lstatSync(dest, { throwIfNoEntry: false });
if (existing) {
  // unlink a symlink (never follow it and delete the source); remove a real copy.
  if (existing.isSymbolicLink()) unlinkSync(dest);
  else rmSync(dest, { recursive: true, force: true });
}
cpSync(path.join(root, "ts-plugin"), dest, { recursive: true });
console.log("Bundled ts-plugin -> node_modules/tw-sugarcube-ts-plugin");
