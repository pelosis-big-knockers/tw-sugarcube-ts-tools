// The actual functionality is the TypeScript language-service plugin contributed
// declaratively via `contributes.typescriptServerPlugins` in package.json — VS
// Code loads it into its tsserver as a global plugin. This activation hook only
// exists so the extension activates when TS/JS files are opened; there is nothing
// to run in the extension host itself.
function activate() {}
function deactivate() {}

module.exports = { activate, deactivate };
