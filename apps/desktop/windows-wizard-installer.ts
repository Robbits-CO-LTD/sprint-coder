import type { ForgeMakeResult } from '@electron-forge/shared-types';
import { sign, type SignToolOptions } from '@electron/windows-sign';
import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

export const SQUIRREL_SETUP_EXE = 'Sprint-Coder-Setup.exe';
export const WINDOWS_WIZARD_INSTALLER_EXE = 'Sprint-Coder-Installer.exe';

type WizardInstallerOptions = Readonly<{
  scriptPath: string;
  iconPath: string;
  isccPath?: string;
  signOptions?: SignToolOptions;
}>;

export type WindowsWizardPlan = Readonly<{
  resultIndex: number;
  sourceSetupPath: string;
  outputDirectory: string;
  outputPath: string;
  version: string;
}>;

export function planWindowsWizardInstaller(
  makeResults: readonly ForgeMakeResult[],
): WindowsWizardPlan | null {
  const candidates = makeResults.flatMap((result, resultIndex) =>
    result.platform === 'win32'
      ? result.artifacts
          .filter((artifact) => basename(artifact) === SQUIRREL_SETUP_EXE)
          .map((sourceSetupPath) => ({ result, resultIndex, sourceSetupPath }))
      : [],
  );
  if (candidates.length === 0) return null;
  if (candidates.length !== 1)
    throw new Error(
      `Expected exactly one ${SQUIRREL_SETUP_EXE} artifact, found ${candidates.length}`,
    );

  const candidate = candidates[0]!;
  const version = candidate.result.packageJSON?.version;
  if (typeof version !== 'string' || version.length === 0)
    throw new Error('Windows installer package version is missing');
  const outputDirectory = dirname(candidate.sourceSetupPath);
  return {
    resultIndex: candidate.resultIndex,
    sourceSetupPath: candidate.sourceSetupPath,
    outputDirectory,
    outputPath: join(outputDirectory, WINDOWS_WIZARD_INSTALLER_EXE),
    version,
  };
}

export function resolveInnoSetupCompiler(explicitPath?: string): string {
  if (process.platform !== 'win32')
    throw new Error('The Windows installer wizard can only be compiled on Windows');

  const candidates = [
    explicitPath,
    process.env['SPRINT_CODER_ISCC_PATH'],
    process.env['ProgramFiles(x86)'] === undefined
      ? undefined
      : join(process.env['ProgramFiles(x86)'], 'Inno Setup 6', 'ISCC.exe'),
    process.env['ProgramFiles'] === undefined
      ? undefined
      : join(process.env['ProgramFiles'], 'Inno Setup 6', 'ISCC.exe'),
  ];
  for (const candidate of candidates)
    if (candidate !== undefined && existsSync(candidate)) return resolve(candidate);

  try {
    const located = execFileSync('where.exe', ['ISCC.exe'], {
      encoding: 'utf8',
      windowsHide: true,
    })
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .find((line) => line.length > 0 && existsSync(line));
    if (located !== undefined) return resolve(located);
  } catch {
    // Report one actionable error below after every supported discovery path has been checked.
  }
  throw new Error(
    'Inno Setup 6 compiler was not found. Install Inno Setup or set SPRINT_CODER_ISCC_PATH.',
  );
}

export async function createWindowsWizardInstaller(
  makeResults: ForgeMakeResult[],
  options: WizardInstallerOptions,
): Promise<ForgeMakeResult[]> {
  const plan = planWindowsWizardInstaller(makeResults);
  if (plan === null) return makeResults;
  if (!existsSync(plan.sourceSetupPath))
    throw new Error(`Squirrel setup artifact was not found: ${plan.sourceSetupPath}`);

  execFileSync(
    resolveInnoSetupCompiler(options.isccPath),
    [
      `/DSourceSetup=${resolve(plan.sourceSetupPath)}`,
      `/DOutputDir=${resolve(plan.outputDirectory)}`,
      `/DAppVersion=${plan.version}`,
      `/DSetupIcon=${resolve(options.iconPath)}`,
      resolve(options.scriptPath),
    ],
    { stdio: 'inherit', windowsHide: true },
  );
  if (!existsSync(plan.outputPath)) throw new Error(`Inno Setup did not create ${plan.outputPath}`);

  if (options.signOptions !== undefined)
    await sign({ ...options.signOptions, files: [plan.outputPath] });

  // Only the wizard is user-facing. It embeds this Squirrel bootstrapper, while RELEASES and the
  // full nupkg remain separate release assets for Electron's native Windows autoUpdater.
  rmSync(plan.sourceSetupPath);
  return makeResults.map((result, resultIndex) =>
    resultIndex === plan.resultIndex
      ? {
          ...result,
          artifacts: result.artifacts.map((artifact) =>
            artifact === plan.sourceSetupPath ? plan.outputPath : artifact,
          ),
        }
      : result,
  );
}
