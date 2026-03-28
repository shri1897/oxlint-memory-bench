/**
 * Custom ESLint plugin that removes unused imports.
 * This is a minimal plugin used to demonstrate memory scaling issues
 * when loaded via oxlint's jsPlugins in large monorepos.
 */

const rule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Remove unused imports',
    },
    fixable: 'code',
    schema: [],
  },
  create(context) {
    const unusedImports = new Map();

    return {
      ImportDeclaration(node) {
        for (const specifier of node.specifiers) {
          unusedImports.set(specifier.local.name, { specifier, node });
        }
      },
      'Identifier:not(ImportSpecifier > Identifier):not(ImportDefaultSpecifier > Identifier):not(ImportNamespaceSpecifier > Identifier)'(node) {
        unusedImports.delete(node.name);
      },
      'Program:exit'() {
        for (const [name, { specifier, node }] of unusedImports) {
          // Skip type imports
          if (node.importKind === 'type' || specifier.importKind === 'type') {
            continue;
          }

          context.report({
            node: specifier,
            message: `'${name}' is imported but never used.`,
            fix(fixer) {
              const specifiers = node.specifiers.filter(
                (s) => s.importKind !== 'type'
              );

              // If this is the only non-type specifier, remove the entire import
              if (specifiers.length === 1) {
                return fixer.remove(node);
              }

              // Otherwise remove just this specifier
              const idx = node.specifiers.indexOf(specifier);
              const nextToken = node.specifiers[idx + 1];
              if (nextToken) {
                return fixer.removeRange([specifier.range[0], nextToken.range[0]]);
              }
              const prevToken = node.specifiers[idx - 1];
              if (prevToken) {
                return fixer.removeRange([prevToken.range[1], specifier.range[1]]);
              }
              return fixer.remove(specifier);
            },
          });
        }
      },
    };
  },
};

export default {
  rules: {
    'no-unused-imports': rule,
  },
};
