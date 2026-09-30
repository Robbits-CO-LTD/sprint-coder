import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { sandboxNodeOptions } from './sandbox-node-pipe-guard';

async function exec(
  file: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; windowsHide?: boolean; timeout?: number } = {},
) {
  const result = spawnSync(file, args, {
    ...options,
    encoding: 'utf8',
    timeout: options.timeout ?? 20_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw Object.assign(new Error(result.stderr), { code: result.status });
  return { stdout: result.stdout, stderr: result.stderr };
}
const build = resolve(__dirname, '../../sandbox-runner/build/Release');
const available =
  process.platform === 'win32' && existsSync(join(build, 'sprint-coder-sandbox-runner.exe'));

describe.skipIf(!available)('sandbox pipe preload in real Windows AppContainer', () => {
  it('rejects pipes/IPC, preserves pipe-free children and filesystem boundaries using quoted Unicode resources', async () => {
    const base = await mkdtemp(join(tmpdir(), 'sc-pipe-guard-'));
    const resources = join(base, '日本語 resources');
    const workspace = join(base, 'workspace');
    await mkdir(resources);
    await mkdir(workspace);
    const runner = join(resources, 'sprint-coder-sandbox-runner.exe');
    const preload = join(resources, 'sandbox-node-pipe-guard.cjs');
    await copyFile(join(build, 'sprint-coder-sandbox-runner.exe'), runner);
    await copyFile(join(build, 'sandbox-node-pipe-guard.cjs'), preload);
    const initialAcl = (await exec('icacls.exe', [preload], { windowsHide: true })).stdout;
    const outside = join(base, 'outside-secret.txt');
    await writeFile(outside, 'private');
    await writeFile(
      join(workspace, 'npm-test.cjs'),
      "require('node:child_process').spawnSync(process.execPath,['--test','case.test.cjs']);\n",
    );
    await writeFile(join(workspace, 'case.test.cjs'), "require('node:test')('works',()=>{});\n");
    await writeFile(join(workspace, 'child.cjs'), 'process.exit(0);\n');
    const script = `
      const cp=require('node:child_process'),a=require('node:assert/strict'),fs=require('node:fs');
      const blocked=(fn)=>a.throws(fn,{code:'SPRINT_CODER_SANDBOX_NODE_PIPE_UNSUPPORTED'});
      blocked(()=>cp.execFileSync(process.execPath,['child.cjs']));
      blocked(()=>cp.execSync('echo 7'));
      blocked(()=>cp.spawn(process.execPath,['child.cjs']));
      blocked(()=>cp.fork('missing.cjs'));
      blocked(()=>cp.fork('missing.cjs',[],{stdio:'inherit'}));
      blocked(()=>cp.execFile(process.execPath,['child.cjs'],()=>{}));
      blocked(()=>cp.spawnSync(process.execPath,[],{stdio:['ignore','ignore','pipe']}));
      const ignored=cp.spawnSync(process.execPath,['child.cjs'],{stdio:'ignore'});
      a.equal(ignored.status,0,JSON.stringify({code:ignored.error?.code,signal:ignored.signal}));
      a.equal(cp.execFileSync(process.execPath,['child.cjs'],{stdio:'inherit'}),null);
      a.throws(()=>fs.readFileSync(${JSON.stringify(outside)}));
      a.throws(()=>fs.writeFileSync(${JSON.stringify(outside)},'changed'));
      fs.writeFileSync('inside.txt','allowed');
      console.log('APP_CONTAINER_GUARD_OK');
    `;
    await writeFile(join(workspace, 'guard-accept.cjs'), script);
    await writeFile(
      join(workspace, 'guard-accept.mjs'),
      "import {spawnSync} from 'node:child_process';try{spawnSync(process.execPath,[])}catch(e){if(e.code==='SPRINT_CODER_SANDBOX_NODE_PIPE_UNSUPPORTED')console.log('ESM_OK');else throw e;}\n",
    );
    await writeFile(
      join(workspace, 'must-not-start.cjs'),
      "require('fs').writeFileSync('should-not-start','bad');\n",
    );
    const env = {
      ...process.env,
      SPRINT_CODER_SANDBOX_NODE_PIPE_GUARD: '1',
      NODE_OPTIONS: sandboxNodeOptions(preload),
    };
    const args = [
      '--exec',
      'workspace-write',
      workspace,
      '--protected-home',
      process.env.USERPROFILE!,
      '--',
      process.execPath,
    ];
    const result = await exec(runner, [...args, 'guard-accept.cjs'], {
      cwd: workspace,
      env,
      windowsHide: true,
      timeout: 20_000,
    });
    expect(result.stdout.trim()).toBe('APP_CONTAINER_GUARD_OK');
    expect(await readFile(outside, 'utf8')).toBe('private');
    expect(await readFile(join(workspace, 'inside.txt'), 'utf8')).toBe('allowed');
    const esm = await exec(runner, [...args, 'guard-accept.mjs'], {
      cwd: workspace,
      env,
      windowsHide: true,
      timeout: 20_000,
    });
    expect(esm.stdout.trim()).toBe('ESM_OK');
    await expect(
      exec(runner, [...args, 'npm-test.cjs'], {
        cwd: workspace,
        env,
        windowsHide: true,
        timeout: 20_000,
      }),
    ).rejects.toThrow('cannot create child-process pipes/IPC safely');
    const beforeAcl = (await exec('icacls.exe', [preload], { windowsHide: true })).stdout;
    expect(beforeAcl).toBe(initialAcl);
    await writeFile(preload, 'throw new Error("untrusted replacement");');
    await expect(
      exec(runner, [...args, 'must-not-start.cjs'], {
        cwd: workspace,
        env,
        windowsHide: true,
        timeout: 20_000,
      }),
    ).rejects.toMatchObject({ code: 70 });
    expect(existsSync(join(workspace, 'should-not-start'))).toBe(false);
    const afterAcl = (await exec('icacls.exe', [preload], { windowsHide: true })).stdout;
    expect(afterAcl).toBe(beforeAcl);
    await rename(preload, `${preload}.disabled`);
    await expect(
      exec(runner, [...args, 'must-not-start.cjs'], {
        cwd: workspace,
        env,
        windowsHide: true,
        timeout: 20_000,
      }),
    ).rejects.toMatchObject({ code: 70 });
    expect(existsSync(join(workspace, 'should-not-start'))).toBe(false);
    // Keep this isolated fixture for evidence. No user directory or external state is removed.
    expect(dirname(runner)).toBe(resources);
  }, 60_000);
});
