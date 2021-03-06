"use strict";

// node 4 .includes polyfill
require("./lib/polyfill");

const DEFAULT_OPTIONS = {
  // Only Cu.imports matching the following pattern will be rewritten as import statements.
  basePath: /^resource:\/\//,

  // Should the import path be rewritten to exclude the basePath?
  // e.g. if the basePath is "resource://}, "resource://foo.jsm" becomes "foo.jsm"
  replace: false
};


function isThisExpressionWithIdentifier(path) {
  return path.isExpressionStatement() &&
    path.get("expression").isAssignmentExpression() &&
    path.get("expression.left.object").isThisExpression() &&
    path.get("expression.left.property").isIdentifier();
}

module.exports = function plugin(babel) {
  const t = babel.types;

  function replaceExports(nodes, exportedSymbols) {
    nodes.forEach(path => {
      // var a = ...
      if (path.isVariableDeclaration()) {
        const declarations = path.get("declarations");
        if (declarations.length !== 1 || !declarations[0].get("id").isIdentifier()) return;
        const name = declarations[0].get("id.name").node;
        if (!exportedSymbols.has(name)) return;
        const value = declarations[0].get("init");

        // var a = b;
        if (value.isIdentifier() && value.node.name !== "undefined") {
          path.replaceWith(t.exportNamedDeclaration(null, [t.exportSpecifier(value.node, t.identifier(name))]));
        }
        // var a = ...
        else {
          path.replaceWith(t.exportNamedDeclaration(path.node, []));
        }
      }
      // function a {}
      else if (path.isFunctionDeclaration() || path.isClassDeclaration()) {
        const name = path.node.id.name;
        if (!exportedSymbols.has(name)) return;
        path.replaceWith(t.exportNamedDeclaration(path.node, []));
      }
    });
  }

  function replaceThisExpressions(nodes) {
    nodes.forEach(path => {
      if (!isThisExpressionWithIdentifier(path)) return;
      const leftName = path.get("expression.left.property").node.name;
      const right = path.get("expression.right");

      // this.a = a;
      if (right.isIdentifier() && right.node.name === leftName) {
        path.remove();
      }
      // this.a = function a () {}....
      else if ((right.isFunctionExpression() || right.isClassExpression()) && right.node.id.name === leftName) {
        path.replaceWith(t.toStatement(right.node));
      }
      else {
        path.replaceWith(t.variableDeclaration("var", [t.variableDeclarator(t.identifier(leftName), right.node)]));
      }
    });
  }

  function checkForDeclarations(nodes, id, finalResults) {
    const results = [];
    if (!finalResults) finalResults = [];
    nodes.forEach(parentPath => {
      if (!parentPath.isVariableDeclaration()) return;
      parentPath.traverse({
        VariableDeclarator(path) {
          if (!path.get("id").isIdentifier()) return;
          const init = path.get("init");
          if (init.isIdentifier() && init.node.name === id) {
            results.push(path.node.id.name);
          }
        }
      });
    });
    if (results.length) {
      finalResults.push.apply(finalResults, results);
      results.forEach(name => {
        checkForDeclarations(nodes, name, finalResults);
      });
      return finalResults;
    } else {
      return finalResults;
    }
  }

  function checkForUtilsDeclarations(nodes, ids) {
    const results = [];
    nodes.forEach(parentPath => {
      if (!parentPath.isVariableDeclaration()) return;
      parentPath.traverse({
        VariableDeclarator(path) {
          const id = path.get("id");
          const init = path.get("init");

          // const {utils} = Components;
          if (
            id.isObjectPattern() &&
            init.isIdentifier() &&
            ids.includes(init.node.name)
          ) {
            id.node.properties.forEach(prop => {
              if (prop.key.name === "utils") {
                results.push(prop.value.name);
              }
            });
          }

          // const foo = Components.utils;
          else if (
            id.isIdentifier() &&
            init.isMemberExpression() &&
            init.get("object").isIdentifier() &&
            ids.includes(init.get("object").node.name) &&
            init.get("property").isIdentifier() &&
            init.get("property").node.name === "utils"
          ) {
            results.push(id.node.name);
          }
        }
      });
    });
    return results;
  }

  function checkForExportedSymbols(nodes) {
    let result;
    nodes.forEach(path => {
      if (
        path.isExpressionStatement() &&
        path.get("expression").isAssignmentExpression() &&
        path.get("expression.left.object").isThisExpression() &&
        path.get("expression.left.property").isIdentifier() &&
        path.get("expression.left.property").node.name === "EXPORTED_SYMBOLS"
      ) {
        result = {
          path,
          values: path.get("expression.right.elements").map(e => e.node.value)
        };
      }
    });
    return result;
  }

  function replaceImports(nodes, ComponentNames, CuNames, basePath, replacePath) {
    nodes.forEach(p => {
      if (!p.isVariableDeclaration()) return;
      p.traverse({
        CallExpression(path) {
          if (
            t.isStringLiteral(path.node.arguments[0]) &&
            path.node.arguments[0].value.match(basePath) &&
            t.isObjectPattern(path.parentPath.node.id) &&

            //Check if actually Components.utils.import
            path.get("callee").isMemberExpression() &&
            path.get("callee.property").node.name === "import"
          ) {
            const callee = path.get("callee");
            if (callee.get("object").isMemberExpression()) {
              if (
                !ComponentNames.includes(callee.get("object.object").node.name) ||
                callee.get("object.property").node.name !== "utils"
              ) {
                return;
              }
            } else {
              if (!CuNames.includes(callee.get("object").node.name)) {
                return;
              }
            }
            const specifiers = path.parentPath.node.id.properties.map(prop => {
              return t.importSpecifier(t.identifier(prop.value.name), t.identifier(prop.key.name));
            });
            let filePath = path.node.arguments[0].value;
            if (replacePath) filePath = filePath.replace(basePath, "");
            const decl = t.importDeclaration(specifiers, t.stringLiteral(filePath));
            path.parentPath.parentPath.replaceWith(decl);
          }
        }
      });
    });

  }

  return {
    visitor: {
      Program(path, state) {
        const opts = Object.assign({}, DEFAULT_OPTIONS, state.opts);
        const topLevelNodes = path.get("body");
        const ids = checkForDeclarations(topLevelNodes, "Components", ["Components"]);
        const utils = checkForUtilsDeclarations(topLevelNodes, ids);
        replaceImports(topLevelNodes, ids, utils, opts.basePath, opts.replace);

        const exportedSymbols = checkForExportedSymbols(topLevelNodes);
        if (exportedSymbols) {
          replaceThisExpressions(topLevelNodes);
          replaceExports(topLevelNodes, new Set(exportedSymbols.values));

          exportedSymbols.path.remove();
          // TODO: throw exportedSymbols.path.buildCodeFrameError if not all paths were converted?
        }

      }
    }
  }
};
