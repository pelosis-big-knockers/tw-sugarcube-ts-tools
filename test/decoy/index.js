// A stand-in for the other global plugins a real VS Code session loads
// (@vscode/copilot-typescript-server-plugin, typescript-svelte-plugin, ...).
//
// This is not a mock of those plugins' features — it models the two things about
// them that can break us:
//
//   1. They wrap `info.serverHost` too. Whoever is loaded after us wraps our
//      patched methods; whoever is loaded before us holds a reference to the
//      pre-patch host. Our injection has to survive being anywhere in that chain.
//   2. They proxy the language service. If our `getExternalFiles` or our
//      generation depends on being the outermost proxy, that shows up here.
//
// The decoy deliberately captures the host methods eagerly, at create() time,
// which is the pessimistic case for a plugin loaded before ours.
module.exports = function init(_modules) {
  function create(info) {
    const tag = (info.config && info.config.name) || "decoy";
    const host = info.serverHost;

    if (host) {
      // Eager capture: bind the methods as they exist right now. A plugin loaded
      // before us therefore delegates to the UNPATCHED host, which is exactly the
      // shape that made an earlier version of our plugin lose its content.
      const readFile = host.readFile && host.readFile.bind(host);
      const fileExists = host.fileExists && host.fileExists.bind(host);
      const watchFile = host.watchFile && host.watchFile.bind(host);

      if (readFile) host.readFile = (file, encoding) => readFile(file, encoding);
      if (fileExists) host.fileExists = (file) => fileExists(file);
      if (watchFile) {
        host.watchFile = (file, cb, interval, options) => {
          info.project.projectService.logger.info(`[${tag}] watchFile ${file}`);
          return watchFile(file, cb, interval, options);
        };
      }
    }

    // Proxy the language service the way a real plugin does.
    const proxy = Object.create(null);
    for (const key of Object.keys(info.languageService)) {
      const member = info.languageService[key];
      proxy[key] = typeof member === "function"
        ? (...args) => member.apply(info.languageService, args)
        : member;
    }
    info.project.projectService.logger.info(`[${tag}] create`);
    return proxy;
  }

  return { create };
};
