import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

function readSignatureScript(filename: string): string {
  const source = ts.createSourceFile(
    filename,
    readFileSync(join(__dirname, filename), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const scripts: string[] = [];
  function visit(node: ts.Node): void {
    if (ts.isArrayLiteralExpression(node)) {
      const commandIndex = node.elements.findIndex(
        (element) => ts.isStringLiteral(element) && element.text === '-Command',
      );
      const script = node.elements[commandIndex + 1];
      if (commandIndex >= 0 && script !== undefined) {
        if (ts.isStringLiteral(script)) scripts.push(script.text);
        else if (
          ts.isCallExpression(script) &&
          ts.isPropertyAccessExpression(script.expression) &&
          script.expression.name.text === 'join' &&
          ts.isArrayLiteralExpression(script.expression.expression)
        ) {
          const separator = script.arguments[0];
          if (separator === undefined || !ts.isStringLiteral(separator))
            throw new Error('Expected a literal script join separator');
          scripts.push(
            script.expression.expression.elements
              .map((line) => {
                if (!ts.isStringLiteral(line)) throw new Error('Expected a literal script line');
                return line.text;
              })
              .join(separator.text),
          );
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  expect(scripts).toHaveLength(1);
  return scripts[0]!;
}

describe.each(['computer-use-native-windows.ts', 'computer-use-native.ts'])(
  'Windows signature PowerShell in %s',
  (filename) => {
    it('disables module autoloading before any other statement', () => {
      expect(readSignatureScript(filename).split(/[;\n]/u)[0]?.trim()).toBe(
        "$PSModuleAutoLoadingPreference = 'None'",
      );
    });

    it('qualifies every cmdlet and explicitly imports its module from PSHOME', () => {
      const script = readSignatureScript(filename);
      // Verb-Noun extraction cannot detect aliases or indirect calls such as & $command.
      expect(script).not.toMatch(/(?:^|[\s;|{}])(?:gps|select|%|\?|iex|sc)(?=$|[\s;|{}])/iu);
      const commands = [...script.matchAll(/(?:[\w.]+\\)?[A-Za-z]+-[A-Za-z]+/gu)].map(
        (match) => match[0],
      );
      expect(commands).toContain('Microsoft.PowerShell.Security\\Get-AuthenticodeSignature');
      expect(commands).toContain('Microsoft.PowerShell.Utility\\ConvertTo-Json');
      if (filename === 'computer-use-native-windows.ts')
        expect(commands).toContain('Microsoft.PowerShell.Management\\Get-Process');
      for (const command of commands) {
        expect(command).toMatch(/^Microsoft\.PowerShell\.\w+\\[A-Za-z]+-[A-Za-z]+$/u);
        const module = command.split('\\')[0];
        // Core supplies Import-Module in a fresh PowerShell session without an import.
        if (module === 'Microsoft.PowerShell.Core') {
          expect(command).toBe('Microsoft.PowerShell.Core\\Import-Module');
          continue;
        }
        const importStatement = `Microsoft.PowerShell.Core\\Import-Module "$PSHOME\\Modules\\${module}\\${module}.psd1"`;
        expect(script).toContain(importStatement);
        expect(script.indexOf(importStatement)).toBeLessThan(script.indexOf(command));
      }
    });

    it.runIf(process.platform === 'win32')(
      'loads only the explicit modules in the minimal Windows environment',
      (context) => {
        const script = readSignatureScript(filename);
        // Replace only Authenticode lookups to avoid certificate network access; execute the
        // remaining body, including process lookup, hashing and JSON serialization, unchanged.
        const executableScript = script.replace(
          /Microsoft\.PowerShell\.Security\\Get-AuthenticodeSignature -LiteralPath \$(?:imagePath|env:SPRINT_CODER_COMPUTER_USE_HELPER|env:SPRINT_CODER_APP_EXE)/gu,
          "[pscustomobject]@{Status='Valid';SignerCertificate=[pscustomobject]@{Thumbprint='synthetic-thumbprint'}}",
        );
        const modules = ['Microsoft.PowerShell.Security', 'Microsoft.PowerShell.Utility'];
        if (filename === 'computer-use-native-windows.ts')
          modules.push('Microsoft.PowerShell.Management');
        const env = Object.fromEntries(
          ['SystemRoot', 'WINDIR', 'TEMP', 'TMP'].flatMap((key) => {
            const value = process.env[key];
            return value === undefined ? [] : [[key, value]];
          }),
        );
        env.SPRINT_CODER_COMPUTER_USE_HELPER_PID = String(process.pid);
        env.SPRINT_CODER_COMPUTER_USE_HELPER = process.execPath;
        env.SPRINT_CODER_APP_EXE = process.execPath;
        // Diagnostics ships in PSHOME and neither product script imports it. Utility's
        // Get-Date would already be loaded and therefore cannot probe disabled autoloading.
        const probe = [
          'if (-not [System.IO.File]::Exists("$PSHOME\\Modules\\Microsoft.PowerShell.Diagnostics\\Microsoft.PowerShell.Diagnostics.psd1")) { throw "Diagnostics module unavailable" }',
          'if (Microsoft.PowerShell.Core\\Get-Module Microsoft.PowerShell.Diagnostics) { throw "Diagnostics already loaded" }',
          '$autoloadBlocked = $false',
          'try { Get-Counter -ListSet "SprintCoderSyntheticMissingCounter" -ErrorAction Stop | Microsoft.PowerShell.Core\\Out-Null }',
          'catch [System.Management.Automation.CommandNotFoundException] { $autoloadBlocked = $true }',
          'catch { throw "Autoload probe resolved the cmdlet" }',
          'if (-not $autoloadBlocked) { throw "Autoload probe resolved the cmdlet" }',
          '@(Microsoft.PowerShell.Core\\Get-Module).Name | Microsoft.PowerShell.Utility\\ConvertTo-Json -Compress',
        ].join('\n');
        let output: string;
        try {
          output = execFileSync(
            'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
            [
              '-NoLogo',
              '-NoProfile',
              '-NonInteractive',
              '-Command',
              `${executableScript}\n${probe}`,
            ],
            { env, encoding: 'utf8', timeout: 30_000, windowsHide: true },
          );
        } catch (error) {
          if (
            error instanceof Error &&
            'code' in error &&
            (error.code === 'EPERM' || error.code === 'EACCES')
          ) {
            context.skip(`NOT_RUN: PowerShell spawn denied (${error.code})`);
            return;
          }
          throw error;
        }
        const lines = output.trim().split(/\r?\n/u);
        expect(lines).toHaveLength(2);
        const result: unknown = JSON.parse(lines[0]!);
        if (filename === 'computer-use-native-windows.ts') {
          expect(result).toEqual({
            imagePath: process.execPath,
            binaryDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
            signatureStatus: 'Valid',
            signerThumbprint: 'synthetic-thumbprint',
          });
        } else {
          expect(result).toEqual({
            HelperStatus: 'Valid',
            AppStatus: 'Valid',
            HelperThumbprint: 'synthetic-thumbprint',
            AppThumbprint: 'synthetic-thumbprint',
          });
        }
        expect((JSON.parse(lines[1]!) as string[]).sort()).toEqual(modules.sort());
      },
      45_000,
    );
  },
);
