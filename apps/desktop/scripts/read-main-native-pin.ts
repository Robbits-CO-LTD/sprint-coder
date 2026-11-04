import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { parseComputerUseNativeCompiledPin } from '../src/main/computer-use-native-provenance';

/** Read unminified Vite Main output without executing Electron or bundle code.
 * Follow the production parser argument, including Vite's hoisted define variable.
 * Unknown output shapes fail closed; unrelated eligibility objects are not pins.
 */
export function readMainNativePin(path: string) {
  const source = ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const initializers = new Map<string, ts.Expression[]>();
  const resolvers: ts.FunctionDeclaration[] = [];
  for (const statement of source.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer) {
          const name = declaration.name.text;
          initializers.set(name, [...(initializers.get(name) ?? []), declaration.initializer]);
        }
      }
    }
    if (
      ts.isFunctionDeclaration(statement) &&
      statement.name?.text === 'resolveComputerUseNativeCompiledPin'
    )
      resolvers.push(statement);
  }
  const fail = (): never => {
    throw new Error('Main bundle pin is missing, ambiguous or unsupported');
  };
  function literal(node: ts.Expression): unknown {
    if (ts.isParenthesizedExpression(node)) return literal(node.expression);
    if (ts.isStringLiteral(node)) return node.text;
    if (ts.isNumericLiteral(node)) return Number(node.text);
    if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (node.kind === ts.SyntaxKind.NullKeyword) return null;
    if (ts.isObjectLiteralExpression(node)) {
      const entries: [string, unknown][] = [];
      for (const property of node.properties) {
        if (
          !ts.isPropertyAssignment(property) ||
          !(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
        )
          return fail();
        const key = property.name.text;
        if (entries.some(([name]) => name === key)) return fail();
        entries.push([key, literal(property.initializer)]);
      }
      return Object.fromEntries(entries);
    }
    return fail();
  }
  const candidates: ts.Expression[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'parseComputerUseNativeCompiledPin'
    ) {
      const argument = node.arguments[0];
      // The options override is a separate runtime-only branch in the production resolver.
      if (
        argument &&
        ts.isPropertyAccessExpression(argument) &&
        argument.getText(source) === 'options.compiledPin'
      )
        return;
      if (node.arguments.length !== 1 || !argument) return fail();
      candidates.push(argument);
    }
    ts.forEachChild(node, visit);
  };
  if (resolvers.length !== 1 || !resolvers[0]?.body) return fail();
  visit(resolvers[0].body);
  if (candidates.length !== 1) return fail();
  let candidate = candidates[0]!;
  if (ts.isIdentifier(candidate)) {
    const values = initializers.get(candidate.text);
    if (values?.length !== 1) return fail();
    candidate = values[0]!;
  }
  return parseComputerUseNativeCompiledPin(literal(candidate));
}
