// Stage the language-service plugin and its analysis core into node_modules
// under their package names so (1) VS Code can resolve the plugin for
// `contributes.typescriptServerPlugins`, and (2) vsce bundles both into the
// .vsix. A plain `file:` dependency would symlink them, which vsce can't
// package — so we copy instead.
import { cpSync, mkdirSync, rmSync, lstatSync, unlinkSync, existsSync, realpathSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const nodeModules = path.join(root, "node_modules");
mkdirSync(nodeModules, { recursive: true });

// Copy `from` to node_modules/<name>, replacing whatever is there.
function stage(from, name) {
  const dest = path.join(nodeModules, name);
  // lstat, not existsSync: existsSync FOLLOWS symlinks, so a dangling leftover
  // `file:`-dependency link reads as "nothing there", skips this cleanup, and
  // crashes cpSync below — the very case the symlink branch exists for.
  const existing = lstatSync(dest, { throwIfNoEntry: false });
  if (existing) {
    // unlink a symlink (never follow it and delete the source); remove a real copy.
    if (existing.isSymbolicLink()) unlinkSync(dest);
    else rmSync(dest, { recursive: true, force: true });
  }
  // Staging a sibling *checkout* rather than a built package, so skip the things
  // that belong to the checkout and not to the published files — .git especially,
  // which is large and would ride along into the .vsix.
  const skip = new Set([".git", "node_modules"]);
  cpSync(from, dest, { recursive: true, filter: (src) => !skip.has(path.basename(src)) });
  console.log(`Bundled ${path.relative(root, from).replace(/\\/g, "/")} -> node_modules/${name}`);
}

stage(path.join(root, "ts-plugin"), "tw-sugarcube-ts-plugin");

// The analysis core that the plugin, bin/lint.js and tw-server's build all
// share. It is NOT optional: without it the plugin's
// `require("tw-sugarcube-analyzer/analyzer.js")` throws inside tsserver, which
// takes down the whole language service rather than degrading — so fail loudly
// here instead of shipping a .vsix that breaks on load.
const ANALYZER = "tw-sugarcube-analyzer";
const analyzerDest = path.join(nodeModules, ANALYZER);
const installed = lstatSync(analyzerDest, { throwIfNoEntry: false });

if (installed && installed.isDirectory()) {
  // npm's own install of the dependency (it resolves the git URL to a real
  // directory, and the lockfile pins which commit). vsce can package that as-is.
  //
  // Leaving it alone is the point: staging over it from a sibling checkout would
  // silently ship whatever is uncommitted on this machine, and the .vsix would
  // then contain an analyzer that no lockfile describes.
  console.log(`Using installed node_modules/${ANALYZER}`);
} else {
  // Either nothing is installed, or it's a symlink — which is what a `file:`
  // dependency leaves behind, and what vsce can't package. Materialize a real
  // copy: from the link's own target if we have one, else a sibling checkout.
  const from = installed && installed.isSymbolicLink()
    ? realpathSync(analyzerDest)
    : path.join(path.dirname(root), ANALYZER);
  if (!existsSync(path.join(from, "package.json"))) {
    console.error(
      `Cannot find ${ANALYZER}: nothing installed in node_modules and no checkout at ${from}. ` +
        `Run npm install, or clone it next to this repo.`
    );
    process.exit(1);
  }
  stage(from, ANALYZER);
}
