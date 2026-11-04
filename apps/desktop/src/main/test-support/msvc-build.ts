import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export type BuildCommand = Readonly<{
  name: string;
  file: string;
  args: string[];
  verbatim: boolean;
}>;
export type Build = Readonly<{
  name: string;
  wrap: (args: string[]) => Omit<BuildCommand, 'name'>;
}>;
const vswhere = 'C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe';

function discoverBuild(): Build | null {
  if (process.platform !== 'win32') return null;
  if (spawnSync('cl.exe', ['/?'], { stdio: 'ignore' }).status === 0)
    return { name: 'cl.exe', wrap: (args) => ({ file: 'cl.exe', args, verbatim: false }) };
  if (!existsSync(vswhere)) return null;
  const found = spawnSync(
    vswhere,
    [
      '-latest',
      '-products',
      '*',
      '-requires',
      'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
      '-property',
      'installationPath',
    ],
    { encoding: 'utf8' },
  );
  const root = found.stdout?.trim() ?? '';
  const vcvars = join(root, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat');
  if (found.error || found.status !== 0 || root === '' || !existsSync(vcvars)) return null;
  return {
    name: 'cl.exe (vcvars64)',
    wrap: (args) => ({
      file: 'cmd.exe',
      args: [
        '/d',
        '/s',
        '/c',
        `"call "${vcvars}" >nul && cl.exe ${args.map((argument) => `"${argument}"`).join(' ')}"`,
      ],
      verbatim: true,
    }),
  };
}

export function findBuild(): Build | null;
export function findBuild(args: string[]): BuildCommand | null;
export function findBuild(args?: string[]): Build | BuildCommand | null {
  const build = discoverBuild();
  if (build === null && process.platform === 'win32' && process.env['CI']) {
    throw new Error('MSVC required on Windows CI: cl.exe and vcvars64.bat were not found');
  }
  return build && args ? { name: build.name, ...build.wrap(args) } : build;
}
