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
      const meta=(r)=>({status:r.status,code:r.error?.code??null,signal:r.signal});
      const controls=()=>{
        const ignore=meta(cp.spawnSync(process.execPath,['child.cjs'],{stdio:'ignore'}));
        const inherit=meta(cp.spawnSync(process.execPath,['child.cjs'],{stdio:'inherit'}));
        const fd=fs.openSync('child-output.txt','w+');
        let file;
        try {file=meta(cp.spawnSync(process.execPath,['child.cjs'],{stdio:[fd,fd,fd]}));}
        finally {fs.closeSync(fd);}
        return {ignore,inherit,file};
      };
      // Same parent, AppContainer token, executable and handles; only the compatibility
      // preload changes. No pipe/IPC operation is attempted before the guard loads.
      process.env.SPRINT_CODER_SANDBOX_NODE_PIPE_GUARD='0';
      const baseline=controls();
      a.throws(()=>fs.readFileSync(${JSON.stringify(outside)}));
      a.throws(()=>fs.writeFileSync(${JSON.stringify(outside)},'changed'));
      fs.writeFileSync('baseline-inside.txt','allowed');
      process.env.SPRINT_CODER_SANDBOX_NODE_PIPE_GUARD='1';
      process.env.NODE_OPTIONS=${JSON.stringify(sandboxNodeOptions(preload))};
      require(${JSON.stringify(preload)});
      const blocked=(fn)=>a.throws(fn,{code:'SPRINT_CODER_SANDBOX_NODE_PIPE_UNSUPPORTED'});
      blocked(()=>cp.execFileSync(process.execPath,['child.cjs']));
      blocked(()=>cp.execSync('echo 7'));
      blocked(()=>cp.spawn(process.execPath,['child.cjs']));
      blocked(()=>cp.fork('missing.cjs'));
      blocked(()=>cp.fork('missing.cjs',[],{stdio:'inherit'}));
      blocked(()=>cp.execFile(process.execPath,['child.cjs'],()=>{}));
      blocked(()=>cp.spawnSync(process.execPath,[],{stdio:['ignore','ignore','pipe']}));
      const guarded=controls();
      const diagnostic=JSON.stringify({baseline,guarded,node:process.version,uv:process.versions.uv});
      a.ok(baseline.ignore.signal===null&&(
        (baseline.ignore.status===0&&baseline.ignore.code===null)||
        (baseline.ignore.status===null&&baseline.ignore.code==='EPERM')
      ),diagnostic);
      a.deepEqual(guarded.ignore,baseline.ignore,diagnostic);
      for(const group of [baseline,guarded]){
        a.deepEqual(group.inherit,{status:0,code:null,signal:null},diagnostic);
        a.deepEqual(group.file,{status:0,code:null,signal:null},diagnostic);
      }
      a.equal(cp.execFileSync(process.execPath,['child.cjs'],{stdio:'inherit'}),null);
      a.throws(()=>fs.readFileSync(${JSON.stringify(outside)}));
      a.throws(()=>fs.writeFileSync(${JSON.stringify(outside)},'changed'));
      fs.writeFileSync('inside.txt','allowed');
      console.log(JSON.stringify({marker:'APP_CONTAINER_GUARD_OK',baseline,guarded,node:process.version,uv:process.versions.uv}));
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
      // The runner still verifies/grants the trusted resource. This parent loads it only
      // after baseline controls; other fixtures below retain product startup preloading.
      env: { ...env, NODE_OPTIONS: '--preserve-symlinks --preserve-symlinks-main' },
      windowsHide: true,
      timeout: 20_000,
    });
    const observation = JSON.parse(result.stdout.trim());
    expect(observation.marker).toBe('APP_CONTAINER_GUARD_OK');
    console.info('AppContainer pipe-free control:', JSON.stringify(observation));
    expect(await readFile(outside, 'utf8')).toBe('private');
    expect(await readFile(join(workspace, 'baseline-inside.txt'), 'utf8')).toBe('allowed');
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
