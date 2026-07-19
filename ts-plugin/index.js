// TypeScript language-service plugin for SugarCube intelligence. SugarCube's
// author-facing containers are populated by plain assignment — `setup.foo = ...`,
// `State.variables.hp = ...`, `settings.volume = ...` — which TypeScript's type
// system can't see (they're empty interfaces). For each such access this plugin
// provides:
//   - completion  (every member gathered from assignments across the project)
//   - go-to-definition  (the assignment site(s))
//   - error suppression  (drop the "property does not exist" diagnostic), so no
//     permissive index-signature augmentation is needed in the project.
//
// The scan helpers are kept container-agnostic so this same core can drive the
// planned twee-passage support.
function init(modules) {
  const ts = modules.typescript;
  // "Property 'x' does not exist" and its did-you-mean variants.
  const PROPERTY_MISSING = new Set([2339, 2551, 2552]);

  const isIdent = (node, name) => ts.isIdentifier(node) && node.text === name;
  const isDotted = (node, obj, prop) =>
    ts.isPropertyAccessExpression(node) && isIdent(node.expression, obj) && node.name.text === prop;

  // The container objects whose members come from assignment. Returns a stable
  // key for an object expression, or null if it isn't a recognized container.
  function containerKey(objExpr) {
    if (isIdent(objExpr, "setup")) return "setup";
    if (isIdent(objExpr, "settings")) return "settings";
    if (isDotted(objExpr, "State", "variables")) return "State.variables";
    if (isDotted(objExpr, "State", "temporary")) return "State.temporary";
    return null;
  }

  // Every `<container>.<name> = ...` assignment across the program, grouped by
  // container key then member name.
  function collectMembers(program) {
    const byContainer = new Map(); // key -> Map(name -> [{ fileName, start, end }])
    for (const sf of program.getSourceFiles()) {
      if (sf.isDeclarationFile || /[\\/]node_modules[\\/]/.test(sf.fileName)) continue;
      const visit = (node) => {
        if (
          ts.isBinaryExpression(node) &&
          node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          ts.isPropertyAccessExpression(node.left)
        ) {
          const key = containerKey(node.left.expression);
          if (key) {
            if (!byContainer.has(key)) byContainer.set(key, new Map());
            const members = byContainer.get(key);
            const name = node.left.name.text;
            if (!members.has(name)) members.set(name, []);
            members.get(name).push({
              fileName: sf.fileName,
              start: node.left.name.getStart(sf),
              end: node.left.name.getEnd(),
            });
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }
    return byContainer;
  }

  // If `position` sits on a `<container>.<name>` member, return { key, name, node }.
  function memberAt(sourceFile, position) {
    let found = null;
    const visit = (node) => {
      if (found) return;
      if (ts.isPropertyAccessExpression(node)) {
        const key = containerKey(node.expression);
        if (key && position >= node.name.getStart(sourceFile) && position <= node.name.getEnd()) {
          found = { key, name: node.name.text, node: node.name };
          return;
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return found;
  }

  // If completion is requested right after `<container>.`, return the container key.
  function containerBeforeDot(sourceFile, position) {
    let hit = null;
    const visit = (node) => {
      if (hit) return;
      if (ts.isPropertyAccessExpression(node)) {
        const key = containerKey(node.expression);
        if (key && position >= node.expression.getEnd() && position <= node.getEnd()) {
          hit = key;
          return;
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return hit;
  }

  function create(info) {
    const ls = info.languageService;
    const proxy = Object.create(null);
    for (const k of Object.keys(ls)) {
      const orig = ls[k];
      proxy[k] = (...args) => orig.apply(ls, args);
    }

    proxy.getCompletionsAtPosition = (fileName, position, options, settings) => {
      const prior = ls.getCompletionsAtPosition(fileName, position, options, settings);
      const program = ls.getProgram();
      const sf = program && program.getSourceFile(fileName);
      const key = sf && containerBeforeDot(sf, position);
      if (!key) return prior;

      const base = prior || {
        isGlobalCompletion: false, isMemberCompletion: true,
        isNewIdentifierLocation: false, entries: [],
      };
      const existing = new Set(base.entries.map((e) => e.name));
      const members = collectMembers(program).get(key);
      for (const name of members ? members.keys() : []) {
        if (existing.has(name)) continue;
        base.entries.push({
          name, kind: ts.ScriptElementKind.memberVariableElement,
          kindModifiers: "", sortText: "0",
        });
      }
      return base;
    };

    proxy.getDefinitionAndBoundSpan = (fileName, position) => {
      const program = ls.getProgram();
      const sf = program && program.getSourceFile(fileName);
      const member = sf && memberAt(sf, position);
      if (!member) return ls.getDefinitionAndBoundSpan(fileName, position);

      const container = collectMembers(program).get(member.key);
      const sites = (container && container.get(member.name)) || [];
      if (sites.length === 0) return ls.getDefinitionAndBoundSpan(fileName, position);

      return {
        textSpan: { start: member.node.getStart(sf), length: member.node.getWidth(sf) },
        definitions: sites.map((s) => ({
          fileName: s.fileName, textSpan: { start: s.start, length: s.end - s.start },
          kind: ts.ScriptElementKind.memberVariableElement, name: member.name,
          containerName: member.key, containerKind: ts.ScriptElementKind.variableElement,
        })),
      };
    };

    // Drop "property does not exist" errors for container member accesses, so a
    // project needs no permissive index-signature augmentation.
    proxy.getSemanticDiagnostics = (fileName) => {
      const prior = ls.getSemanticDiagnostics(fileName);
      const program = ls.getProgram();
      const sf = program && program.getSourceFile(fileName);
      if (!sf) return prior;
      return prior.filter((d) => {
        if (!PROPERTY_MISSING.has(d.code) || typeof d.start !== "number") return true;
        return !memberAt(sf, d.start);
      });
    };

    return proxy;
  }

  return { create };
}

module.exports = init;
