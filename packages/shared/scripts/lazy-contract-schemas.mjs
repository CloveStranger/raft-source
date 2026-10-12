#!/usr/bin/env node
// Mechanical rewrite: wrap every top-level zod schema constant in the Agent API
// contract files with `lazySchema("<name>", () => <initializer>)`, so the
// schema is built on first use instead of at import (see src/lazySchema.ts).
//
// A top-level `const` is a schema when its initializer (after `as` /
// `satisfies` / parentheses) is a call chain rooted at `z`, at
// `passthroughObject`, or at another identifier ending in `Schema`. Nothing
// else is touched: shapes, helper functions, route tables and plain constants
// stay as written. The rewrite is idempotent.
//
//   node scripts/lazy-contract-schemas.mjs          rewrite in place
//   node scripts/lazy-contract-schemas.mjs --check  exit 1 if any file would change
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
export const LAZY_CONTRACT_FILES = ["agentApiContract.ts", "agentApiMessageContract.ts", "daemonApiContract.ts"];
const IMPORT_LINE = `import { lazySchema } from "./lazySchema";\n`;

function rootIdentifier(expression) {
  let current = expression;
  for (;;) {
    if (ts.isCallExpression(current) || ts.isPropertyAccessExpression(current)) current = current.expression;
    else if (ts.isNonNullExpression(current)) current = current.expression;
    else break;
  }
  return ts.isIdentifier(current) ? current.text : null;
}

function unwrapTypeAssertions(expression) {
  let current = expression;
  while (ts.isAsExpression(current) || ts.isSatisfiesExpression(current) || ts.isParenthesizedExpression(current)) {
    current = current.expression;
  }
  return current;
}

function isSchemaInitializer(initializer) {
  const core = unwrapTypeAssertions(initializer);
  if (!ts.isCallExpression(core)) return false;
  const root = rootIdentifier(core);
  return root === "z" || root === "passthroughObject" || (root !== null && root !== "lazySchema" && root.endsWith("Schema"));
}

export function rewriteContractSource(fileName, source) {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const edits = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    if (!(statement.declarationList.flags & ts.NodeFlags.Const)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
      if (!isSchemaInitializer(declaration.initializer)) continue;
      const name = declaration.name.text;
      edits.push({ at: declaration.initializer.getStart(sourceFile), text: `lazySchema(${JSON.stringify(name)}, () => ` });
      edits.push({ at: declaration.initializer.getEnd(), text: ")" });
    }
  }
  if (edits.length === 0) return { output: source, wrapped: 0 };
  let output = source;
  for (const edit of edits.sort((a, b) => b.at - a.at)) {
    output = output.slice(0, edit.at) + edit.text + output.slice(edit.at);
  }
  if (!output.includes(IMPORT_LINE)) {
    const zodImport = output.match(/^import \{ z \} from "zod";\n/m);
    const at = zodImport ? zodImport.index + zodImport[0].length : 0;
    output = output.slice(0, at) + IMPORT_LINE + output.slice(at);
  }
  return { output, wrapped: edits.length / 2 };
}

function main() {
  const check = process.argv.includes("--check");
  let stale = 0;
  for (const file of LAZY_CONTRACT_FILES) {
    const path = join(SRC, file);
    const source = readFileSync(path, "utf8");
    const { output, wrapped } = rewriteContractSource(file, source);
    if (output === source) continue;
    if (check) {
      stale += 1;
      console.error(`${file}: ${wrapped} top-level schema(s) are not wrapped in lazySchema; run node packages/shared/scripts/lazy-contract-schemas.mjs`);
    } else {
      writeFileSync(path, output);
      console.log(`${file}: wrapped ${wrapped} schema(s)`);
    }
  }
  if (stale > 0) process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
