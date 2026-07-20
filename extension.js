// Intelligence for .ts/.js lives in the TypeScript language-service plugin
// contributed via `contributes.typescriptServerPlugins`; VS Code loads it into
// its tsserver. This activation hook forwards the `twSugarcube.strict` setting
// down to the plugin, and registers the passage (.twee) language features.
const vscode = require("vscode");
const passages = require("./passages.js");

const PLUGIN_ID = "tw-sugarcube-ts-plugin";
const SECTION = "twSugarcube";

async function activate(context) {
  // Passage features degrade independently of the TS plugin wiring below, so
  // register them first and don't let one failure take out the other.
  try {
    passages.register(context);
  } catch (e) {
    console.error("[tw-sugarcube] passage features failed to register", e);
  }

  const tsExtension = vscode.extensions.getExtension("vscode.typescript-language-features");
  if (!tsExtension) return;

  await tsExtension.activate();
  const api = tsExtension.exports && typeof tsExtension.exports.getAPI === "function"
    ? tsExtension.exports.getAPI(0)
    : undefined;
  if (!api) return;

  const send = () =>
    api.configurePlugin(PLUGIN_ID, {
      strict: vscode.workspace.getConfiguration(SECTION).get("strict", true),
    });

  send();
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(`${SECTION}.strict`)) send();
    })
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
