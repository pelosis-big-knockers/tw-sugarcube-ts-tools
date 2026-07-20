// Shared analysis core for SugarCube's author-populated containers.
//
// Two consumers, one implementation:
//   * the TypeScript language-service plugin (ts-plugin/index.js), which gets
//     its `ts` injected by tsserver, and
//   * the command-line linter (bin/lint.js), which requires `typescript`.
//
// So `ts` is a parameter rather than an import — the plugin MUST use the
// TypeScript instance tsserver handed it, not one of its own.
//
// Nothing here touches the filesystem or the editor; callers supply a Program
// and a map of passage projections.
"use strict";

const twee = require("./twee.js");

const ALL_INTERFACES = [
  "SugarCubeSetupObject",
  "SugarCubeStoryVariables",
  "SugarCubeTemporaryVariables",
  "SugarCubeSettingVariables",
];

// `settings` members are normally created through SugarCube's Setting API
// (`Setting.addToggle("volume", ...)`) rather than by assignment, so we can
// never claim to know the full set. It is never closed, whatever the caller
// asks for — closing it would report every real setting as a typo.
const NEVER_CLOSED = new Set(["SugarCubeSettingVariables"]);

const MAX_TYPE_LENGTH = 400;
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const norm = (p) => String(p).replace(/\\/g, "/").toLowerCase();

// Quote a member name only when it isn't a plain identifier. TypeScript echoes
// the declaration's own spelling back in hover and completion detail, so a
// needlessly quoted `"attack"` shows up as `setup["attack"]` even though the
// author writes `setup.attack`.
const propertyKey = (name) => (IDENTIFIER.test(name) ? name : JSON.stringify(name));

function createAnalyzer(ts) {
  const FORMAT =
    ts.TypeFormatFlags.NoTruncation |
    ts.TypeFormatFlags.UseFullyQualifiedType |
    ts.TypeFormatFlags.WriteArrowStyleSignature;

  const isIdent = (n, name) => ts.isIdentifier(n) && n.text === name;
  const isDotted = (n, obj, prop) =>
    ts.isPropertyAccessExpression(n) && isIdent(n.expression, obj) && n.name.text === prop;

  function interfaceFor(objExpr) {
    if (isIdent(objExpr, "setup")) return "SugarCubeSetupObject";
    if (isIdent(objExpr, "settings")) return "SugarCubeSettingVariables";
    if (isDotted(objExpr, "State", "variables")) return "SugarCubeStoryVariables";
    if (isDotted(objExpr, "State", "temporary")) return "SugarCubeTemporaryVariables";
    return null;
  }

  // Module-scoped types serialize as `import("...").X`, which wouldn't resolve
  // inside the generated file; fall back to `any` rather than emit something
  // broken. Same for pathological types.
  function typeStringOf(checker, expr) {
    let type = checker.getWidenedType(checker.getTypeAtLocation(expr));
    type = checker.getBaseTypeOfLiteralType(type);
    const text = checker.typeToString(type, expr, FORMAT);
    if (!text || /\bimport\(/.test(text) || text.length > MAX_TYPE_LENGTH || /[\r\n]/.test(text)) {
      return "any";
    }
    return text;
  }

  // Translate an assignment site inside a passage projection back to the .twee
  // document it came from. Returns null when the span has no counterpart in the
  // source — scaffolding we emitted, never author text.
  function tweeSite(projection, start, end) {
    const mapped = twee.tsRangeToTwee(projection.segments, start, end - start);
    if (!mapped) return null;
    return { fileName: projection.source, start: mapped.start, end: mapped.start + mapped.length };
  }

  /**
   * One walk collecting assignment sites (for go-to-definition) and, when a
   * checker is supplied, member types (for generation).
   *
   * @param projections Map of normalized projection path -> { segments, source }
   */
  function scan(program, checker, skipFile, projections) {
    const found = new Map();
    const entryFor = (iface) => {
      if (!found.has(iface)) found.set(iface, { members: new Map(), dynamic: false });
      return found.get(iface);
    };
    const skip = skipFile ? norm(skipFile) : null;
    const byPath = projections || new Map();

    for (const sf of program.getSourceFiles()) {
      if (sf.isDeclarationFile || /[\\/]node_modules[\\/]/.test(sf.fileName)) continue;
      if (skip && norm(sf.fileName) === skip) continue;
      // Passage projections ARE harvested: `<<set $hp to 10>>` is how most story
      // variables come into existence, so it is the main source of their types.
      // Their assignment sites live in a virtual file the author can't open, so
      // each is translated back to a real span in the .twee document.
      const projection = byPath.get(norm(sf.fileName));
      const visit = (node) => {
        // `Object.assign(setup, {...})` adds members we can't enumerate, so the
        // container has to stay open or every one of them reads as a typo.
        if (ts.isCallExpression(node) && isDotted(node.expression, "Object", "assign")) {
          const target = node.arguments && node.arguments[0];
          const iface = target && interfaceFor(target);
          if (iface) entryFor(iface).dynamic = true;
        }
        if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
          const left = node.left;
          let objExpr = null, name = null, nameNode = null, dynamic = false;
          if (ts.isPropertyAccessExpression(left)) {
            objExpr = left.expression; name = left.name.text; nameNode = left.name;
          } else if (ts.isElementAccessExpression(left)) {
            objExpr = left.expression;
            const arg = left.argumentExpression;
            if (arg && ts.isStringLiteralLike(arg)) { name = arg.text; nameNode = arg; }
            else dynamic = true;
          }
          const iface = objExpr && interfaceFor(objExpr);
          if (iface) {
            const entry = entryFor(iface);
            if (dynamic) entry.dynamic = true;
            else if (name) {
              if (!entry.members.has(name)) entry.members.set(name, { sites: [], types: new Set() });
              const member = entry.members.get(name);
              const start = nameNode.getStart(sf);
              const end = nameNode.getEnd();
              const site = projection
                ? tweeSite(projection, start, end)
                : { fileName: sf.fileName, start, end };
              if (site) member.sites.push(site);
              if (checker) member.types.add(typeStringOf(checker, node.right));
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }
    return found;
  }

  /**
   * Build the `declare module "twine-sugarcube"` augmentation.
   *
   * @param strict         declare recovered member types (false = fully permissive)
   * @param typoDetection  close containers, so an unknown member is an error
   */
  function generate(program, skipFile, strict, typoDetection, projections) {
    const found = scan(program, program.getTypeChecker(), skipFile, projections);
    // Every container is described, even if nothing was assigned to it here.
    for (const name of ALL_INTERFACES) {
      if (!found.has(name)) found.set(name, { members: new Map(), dynamic: true });
    }

    let body = 'import "twine-sugarcube";\ndeclare module "twine-sugarcube" {\n';
    for (const [iface, entry] of found) {
      body += `  interface ${iface} {\n`;
      // Permissive mode is a full escape hatch: no recovered types at all, so
      // nothing inferred here can produce an error.
      if (strict) {
        for (const [name, member] of entry.members) {
          body += `    ${propertyKey(name)}: ${[...member.types].join(" | ") || "any"};\n`;
        }
      }
      // Closing a container is what makes an unknown member an error — that is
      // the whole of typo detection, and it is only sound when every way the
      // container gains members is visible. A computed `setup[expr] =`, an
      // `Object.assign`, or the Setting API each keep their container open.
      //
      // 0.4.0 closed containers unconditionally and reported every
      // passage-created variable as nonexistent. Hence: opt-in, requires strict,
      // and any hint that we can't see everything reopens the container.
      const closed = typoDetection && strict && !entry.dynamic && !NEVER_CLOSED.has(iface);
      if (!closed) body += "    [key: string]: any;\n";
      body += "  }\n";
    }
    return body + "}\n";
  }

  return { interfaceFor, typeStringOf, scan, generate, isIdent, isDotted };
}

module.exports = { createAnalyzer, ALL_INTERFACES, NEVER_CLOSED, propertyKey, norm };
