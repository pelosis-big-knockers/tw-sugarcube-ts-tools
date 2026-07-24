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

// A recovered type is written verbatim into the generated augmentation, so a
// pathological serialization (a deeply instantiated generic, a huge union) would
// bloat a file that tsserver re-parses on every regeneration. Hence a cap — but
// it only exists to catch that pathology, and it is NOT a judgement about how
// big an author's data is allowed to be. A plain table of items,
//
//   setup.items = [{ key: "flowers", name: "Wildflowers", price: 30 }, ...] as const;
//
// serializes every literal member of every element, so three modest rows already
// run past 400 characters; capping there quietly typed real, ordinary story data
// `any` while the identical array of bare strings came through fine.
const MAX_TYPE_LENGTH = 8000;
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const norm = (p) => String(p).replace(/\\/g, "/").toLowerCase();

// How each container is spelled in author code, for messages about its members.
const CONTAINER_DISPLAY = {
  SugarCubeSetupObject: "setup",
  SugarCubeSettingVariables: "settings",
  SugarCubeStoryVariables: "State.variables",
  SugarCubeTemporaryVariables: "State.temporary",
};

// A member whose type can't be declared falls back to `any`, which costs the
// author every check on that member — silently, at the one place they'd never
// think to look. So each fallback carries a reason out to the caller, which
// surfaces it as a warning (the linter as a finding, the plugin as a squiggle on
// the assignment).
//
// The advice is the same for both real reasons and it does work: a type that is
// NAMED and GLOBAL serializes to just its name, and the generated augmentation
// can reference it. SugarCube sources are usually scripts rather than modules,
// so an `interface Gift {...}` in one of them is already global.
const ADVICE = "Give it a named global type (an interface or type alias in a non-module file) to keep it checked.";
const DOWNGRADE_REASON = {
  tooLong: (subject, detail) =>
    `Type of '${subject}' serializes to ${detail} characters, over the ${MAX_TYPE_LENGTH}-character limit, ` +
    `so '${subject}' is typed 'any'. ${ADVICE}`,
  moduleScoped: (subject) =>
    `Type of '${subject}' is declared inside a module, so it can only be written as an 'import(...)' type ` +
    `that the generated declarations can't reference; '${subject}' is typed 'any'. ${ADVICE}`,
  unprintable: (subject) =>
    `Type of '${subject}' could not be written as a single-line type, so '${subject}' is typed 'any'. ${ADVICE}`,
};

// `setup.gifts`, but `setup["odd name"]` when the member isn't an identifier —
// the spelling the author would search for.
function memberDisplay(iface, name) {
  const container = CONTAINER_DISPLAY[iface] || iface;
  return IDENTIFIER.test(name) ? `${container}.${name}` : `${container}[${JSON.stringify(name)}]`;
}

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

  // Assignment operators that establish a member. `=` and the logical-assign
  // forms (`??=`/`||=`/`&&=`) settle the member to their right-hand side's type,
  // so they contribute both a definition site and a type.
  const ASSIGN_TYPED = new Set([
    ts.SyntaxKind.EqualsToken,
    ts.SyntaxKind.QuestionQuestionEqualsToken,
    ts.SyntaxKind.BarBarEqualsToken,
    ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ]);
  // Arithmetic/bitwise compound assignments (`+=`, `-=`, `&=`, ...) also create
  // the member — so it must count as existing for typo detection and offer a
  // definition site — but the right-hand side alone is a misleading type source
  // (`hp += 5` says nothing about hp's type), so they contribute a site only and
  // leave typing to a plain or logical assignment elsewhere.
  const ASSIGN_SITE_ONLY = new Set([
    ts.SyntaxKind.PlusEqualsToken, ts.SyntaxKind.MinusEqualsToken,
    ts.SyntaxKind.AsteriskEqualsToken, ts.SyntaxKind.SlashEqualsToken,
    ts.SyntaxKind.PercentEqualsToken, ts.SyntaxKind.AsteriskAsteriskEqualsToken,
    ts.SyntaxKind.LessThanLessThanEqualsToken, ts.SyntaxKind.GreaterThanGreaterThanEqualsToken,
    ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
    ts.SyntaxKind.AmpersandEqualsToken, ts.SyntaxKind.BarEqualsToken, ts.SyntaxKind.CaretEqualsToken,
  ]);

  const isIdent = (n, name) => ts.isIdentifier(n) && n.text === name;
  const isDotted = (n, obj, prop) =>
    ts.isPropertyAccessExpression(n) && isIdent(n.expression, obj) && n.name.text === prop;

  function namedContainer(objExpr) {
    if (isIdent(objExpr, "setup")) return "SugarCubeSetupObject";
    if (isIdent(objExpr, "settings")) return "SugarCubeSettingVariables";
    if (isDotted(objExpr, "State", "variables")) return "SugarCubeStoryVariables";
    if (isDotted(objExpr, "State", "temporary")) return "SugarCubeTemporaryVariables";
    return null;
  }

  // Authors routinely shorten a container into a local before writing to it:
  //
  //   const sv = State.variables;
  //   sv.name = "Hero";
  //
  // Syntactically `sv.name` looks like nothing at all, so without following the
  // alias the member gets no type and no definition site — and with typo
  // detection it is reported as nonexistent at the very place it is created.
  //
  // Only `const` counts: a `let` can be pointed at some other object further
  // down, and we would then file that object's members under the container.
  // Resolution goes through the symbol rather than the name, so a nested binding
  // that shadows the alias correctly stops resolving, and an alias exported from
  // a shared module still resolves through the import.
  const MAX_ALIAS_HOPS = 8; // `const a = sv` chains; also breaks `const a = a`

  function aliasInitializer(checker, node) {
    if (!checker || !ts.isIdentifier(node)) return null;
    let symbol = checker.getSymbolAtLocation(node);
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    const decl = symbol && symbol.valueDeclaration;
    if (!decl || !ts.isVariableDeclaration(decl) || !decl.initializer) return null;
    if (!(ts.getCombinedNodeFlags(decl) & ts.NodeFlags.Const)) return null;
    return decl.initializer;
  }

  // `checker` is optional: without one this stays the purely syntactic test it
  // has always been, and aliases simply don't resolve.
  function interfaceFor(objExpr, checker) {
    let node = objExpr;
    for (let hops = 0; node && hops <= MAX_ALIAS_HOPS; hops++) {
      const direct = namedContainer(node);
      if (direct) return direct;
      node = aliasInitializer(checker, node);
    }
    return null;
  }

  // Module-scoped types serialize as `import("...").X`, which wouldn't resolve
  // inside the generated file; fall back to `any` rather than emit something
  // broken. Same for pathological types.
  //
  // Returns `{ text, reason, detail }`: `reason` is null when the type came
  // through intact, and otherwise names why it didn't, so the caller can warn
  // instead of letting the member quietly become `any`.
  function typeStringOf(checker, expr) {
    let type = checker.getWidenedType(checker.getTypeAtLocation(expr));
    type = checker.getBaseTypeOfLiteralType(type);
    const text = checker.typeToString(type, expr, FORMAT);
    if (!text) return { text: "any", reason: "unprintable" };
    if (/\bimport\(/.test(text)) return { text: "any", reason: "moduleScoped" };
    if (text.length > MAX_TYPE_LENGTH) return { text: "any", reason: "tooLong", detail: text.length };
    if (/[\r\n]/.test(text)) return { text: "any", reason: "unprintable" };
    return { text, reason: null };
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
   * @param downgrades  Optional array; each member that fell back to `any`
   *                    despite having a real type is pushed onto it.
   */
  function scan(program, checker, skipFile, projections, downgrades) {
    const found = new Map();
    const entryFor = (iface) => {
      if (!found.has(iface)) found.set(iface, { members: new Map(), dynamic: false });
      return found.get(iface);
    };
    const skip = skipFile ? norm(skipFile) : null;
    const byPath = projections || new Map();
    // Aliases resolve through symbols, not types, so they are available even on
    // the site-only walk that deliberately passes no checker. The Program caches
    // this instance, and generation already asks for it.
    const resolver = checker || program.getTypeChecker();

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
          const iface = target && interfaceFor(target, resolver);
          if (iface) entryFor(iface).dynamic = true;
        }
        if (ts.isBinaryExpression(node)) {
          const kind = node.operatorToken.kind;
          const contributesType = ASSIGN_TYPED.has(kind);
          if (contributesType || ASSIGN_SITE_ONLY.has(kind)) {
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
            const iface = objExpr && interfaceFor(objExpr, resolver);
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
                if (checker && contributesType) {
                  const typed = typeStringOf(checker, node.right);
                  member.types.add(typed.text);
                  // No site means the assignment is scaffolding we generated
                  // rather than author text — there is nothing to point at and
                  // nothing they could change, so it isn't worth a warning.
                  if (typed.reason && downgrades && site) {
                    downgrades.push({
                      container: iface,
                      member: name,
                      reason: typed.reason,
                      message: DOWNGRADE_REASON[typed.reason](memberDisplay(iface, name), typed.detail),
                      site, // mapped back to the .twee document when it came from one
                      // Where the span lives in the Program, which is the
                      // projection for a passage. The plugin attaches its
                      // squiggle here, since that is the file tsserver asks about.
                      inProgram: { fileName: sf.fileName, start, end },
                    });
                  }
                }
              }
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
   * @param downgrades     Optional array, filled with the members that fell back
   *                       to `any`. Only collected under `strict`: permissive
   *                       mode declares no types at all, so `any` is the point
   *                       there rather than a loss worth reporting.
   */
  function generate(program, skipFile, strict, typoDetection, projections, downgrades) {
    const found = scan(program, program.getTypeChecker(), skipFile, projections, strict ? downgrades : null);
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

module.exports = {
  createAnalyzer, ALL_INTERFACES, NEVER_CLOSED, propertyKey, norm, memberDisplay, MAX_TYPE_LENGTH,
};
