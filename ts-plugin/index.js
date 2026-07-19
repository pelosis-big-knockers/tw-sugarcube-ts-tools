// TypeScript language-service plugin: teaches the editor about SugarCube's
// `setup.*` members, which are attached by plain assignment (`setup.foo = ...`)
// and so are invisible to TypeScript's type system. It provides, for any
// `setup.<member>` sourced from those assignments:
//   - completion  (list every member gathered across the project)
//   - go-to-definition  (jump to the assignment site(s), including multiples)
//   - error suppression  (drop the "property does not exist" diagnostic), so no
//     permissive index-signature augmentation is needed in the project.
//
// The scan helpers (collectSetupMembers / setupMemberAt / isAfterSetupDot) are
// deliberately isolated so they can move to a shared core when the twee-passage
// support is built.
function init(modules) {
  const ts = modules.typescript;
  const SETUP = "setup";
  // "Property 'x' does not exist" and its did-you-mean variants.
  const PROPERTY_MISSING = new Set([2339, 2551, 2552]);

  function collectSetupMembers(program) {
    const members = new Map(); // name -> [{ fileName, start, end }]
    for (const sf of program.getSourceFiles()) {
      if (sf.isDeclarationFile || /[\\/]node_modules[\\/]/.test(sf.fileName)) continue;
      const visit = (node) => {
        if (
          ts.isBinaryExpression(node) &&
          node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          ts.isPropertyAccessExpression(node.left) &&
          ts.isIdentifier(node.left.expression) &&
          node.left.expression.text === SETUP
        ) {
          const name = node.left.name.text;
          if (!members.has(name)) members.set(name, []);
          members.get(name).push({
            fileName: sf.fileName,
            start: node.left.name.getStart(sf),
            end: node.left.name.getEnd(),
          });
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }
    return members;
  }

  // If `position` sits on a `setup.<name>` property access, return { name, node }.
  function setupMemberAt(sourceFile, position) {
    let found = null;
    const visit = (node) => {
      if (found) return;
      if (
        ts.isPropertyAccessExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === SETUP &&
        position >= node.name.getStart(sourceFile) &&
        position <= node.name.getEnd()
      ) {
        found = { name: node.name.text, node: node.name };
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return found;
  }

  function isAfterSetupDot(sourceFile, position) {
    let hit = false;
    const visit = (node) => {
      if (hit) return;
      if (
        ts.isPropertyAccessExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === SETUP &&
        position >= node.expression.getEnd() &&
        position <= node.getEnd()
      ) {
        hit = true;
        return;
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
      if (!sf || !isAfterSetupDot(sf, position)) return prior;

      const base = prior || {
        isGlobalCompletion: false, isMemberCompletion: true,
        isNewIdentifierLocation: false, entries: [],
      };
      const existing = new Set(base.entries.map((e) => e.name));
      for (const name of collectSetupMembers(program).keys()) {
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
      const member = sf && setupMemberAt(sf, position);
      if (!member) return ls.getDefinitionAndBoundSpan(fileName, position);

      const sites = collectSetupMembers(program).get(member.name) || [];
      if (sites.length === 0) return ls.getDefinitionAndBoundSpan(fileName, position);

      return {
        textSpan: { start: member.node.getStart(sf), length: member.node.getWidth(sf) },
        definitions: sites.map((s) => ({
          fileName: s.fileName, textSpan: { start: s.start, length: s.end - s.start },
          kind: ts.ScriptElementKind.memberVariableElement, name: member.name,
          containerName: SETUP, containerKind: ts.ScriptElementKind.variableElement,
        })),
      };
    };

    // Drop "property does not exist" errors for `setup.<member>` accesses, so a
    // project needs no permissive index-signature augmentation.
    proxy.getSemanticDiagnostics = (fileName) => {
      const prior = ls.getSemanticDiagnostics(fileName);
      const program = ls.getProgram();
      const sf = program && program.getSourceFile(fileName);
      if (!sf) return prior;
      return prior.filter((d) => {
        if (!PROPERTY_MISSING.has(d.code) || typeof d.start !== "number") return true;
        return !setupMemberAt(sf, d.start);
      });
    };

    return proxy;
  }

  return { create };
}

module.exports = init;
