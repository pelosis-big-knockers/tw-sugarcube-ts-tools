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

  // Let the passage features push live (unsaved) buffers to the plugin. Both
  // this send() and the live push go through configurePlugin; the plugin merges
  // them, and a settings-only send has no liveDoc so it never clears an override.
  passages.setLiveApi(api);

  const send = () => {
    const config = vscode.workspace.getConfiguration(SECTION);
    api.configurePlugin(PLUGIN_ID, {
      strict: config.get("strict", true),
      typoDetection: config.get("typoDetection", false),
    });
  };

  send();
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(`${SECTION}.strict`) ||
          event.affectsConfiguration(`${SECTION}.typoDetection`)) send();
    })
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
