import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const TEAM_CORE_FILES = [
  'team-coordinator.ts',
  'team-execution-scheduler.ts',
  'team-tools.ts',
] as const;

const FORBIDDEN_IMPORT =
  /(?:^|\/)(?:openai|anthropic|gemini|openrouter|orcarouter|xai)(?:-provider)?-(?:client|adapter)(?:$|\.)|^(?:openai|@anthropic-ai\/|@google\/generative-ai)/;
const PROVIDER_BRANCH_VALUE = new Set([
  'openai',
  'anthropic',
  'google',
  'gemini',
  'xai',
  'openrouter',
  'orcarouter',
]);

function sourceFile(name: string): ts.SourceFile {
  const path = fileURLToPath(new URL(name, import.meta.url));
  return ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}

function importsOf(file: ts.SourceFile): string[] {
  return file.statements.flatMap((statement) =>
    ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)
      ? [statement.moduleSpecifier.text]
      : [],
  );
}

function providerBranchesOf(file: ts.SourceFile): string[] {
  const findings: string[] = [];
  const visit = (node: ts.Node): void => {
    let condition: ts.Expression | undefined;
    if (ts.isIfStatement(node) || ts.isSwitchStatement(node)) condition = node.expression;
    else if (ts.isConditionalExpression(node)) condition = node.condition;
    if (condition !== undefined) {
      const inspect = (candidate: ts.Node): void => {
        if (
          ts.isStringLiteralLike(candidate) &&
          PROVIDER_BRANCH_VALUE.has(candidate.text.toLowerCase())
        )
          findings.push(
            `${file.fileName}:${file.getLineAndCharacterOfPosition(candidate.getStart()).line + 1}:${candidate.text}`,
          );
        ts.forEachChild(candidate, inspect);
      };
      inspect(condition);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return findings;
}

describe('Team Core Provider architecture boundary', () => {
  it('does not import Provider-specific clients, adapters, or SDKs', () => {
    const findings = TEAM_CORE_FILES.flatMap((name) =>
      importsOf(sourceFile(name))
        .filter((specifier) => FORBIDDEN_IMPORT.test(specifier))
        .map((specifier) => `${name}: ${specifier}`),
    );
    expect(findings).toEqual([]);
  });

  it('does not branch on Provider identity in control-flow conditions', () => {
    const findings = TEAM_CORE_FILES.flatMap((name) => providerBranchesOf(sourceFile(name)));
    expect(findings).toEqual([]);
  });
});
