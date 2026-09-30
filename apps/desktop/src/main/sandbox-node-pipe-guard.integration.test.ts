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
    // CopyFile may leave inherited ACEs awaiting OS normalization. Observe the same
    // grant/remove operation without the product, then establish explicit test modes.
    const aclControl = join(resources, 'acl-control.cjs');
    await copyFile(join(build, 'sandbox-node-pipe-guard.cjs'), aclControl);
    const controlBefore = (await exec('icacls.exe', [aclControl], { windowsHide: true })).stdout;
    const controlSid =
      'S-1-15-2-111111111-222222222-333333333-444444444-555555555-666666666-777777777';
    expect(controlBefore).not.toContain(controlSid);
    await exec('icacls.exe', [aclControl, '/grant', `*${controlSid}:RX`], { windowsHide: true });
    await exec('icacls.exe', [aclControl, '/remove', `*${controlSid}`], { windowsHide: true });
    const controlAfter = (await exec('icacls.exe', [aclControl], { windowsHide: true })).stdout;
    expect(controlAfter).not.toContain(controlSid);
    console.info('Copied ACL grant/remove control changed:', controlBefore !== controlAfter);
    // Normalize only fixture setup, never the native result before comparing it.
    await exec('icacls.exe', [preload, '/inheritance:e'], { windowsHide: true });
    const initialAcl = (await exec('icacls.exe', [preload], { windowsHide: true })).stdout;
    const outside = join(base, 'outside-secret.txt');
    await writeFile(outside, 'private');
    await writeFile(
      join(workspace, 'npm-test.cjs'),
      "require('node:child_process').spawnSync(process.execPath,['--test','case.test.cjs']);\n",
    );
    await writeFile(join(workspace, 'case.test.cjs'), "require('node:test')('works',()=>{});\n");
    await writeFile(join(workspace, 'child.cjs'), 'process.exit(0);\n');
    const controlsSource = `
      const cp=require('node:child_process'),a=require('node:assert/strict'),fs=require('node:fs');
      const code=(error)=>error===undefined?null:
        ['EPERM','EACCES','ENOENT','EINVAL','EBADF','ETIMEDOUT'].includes(error.code)?error.code:'UNKNOWN';
      const meta=(r)=>({status:r.status,code:code(r.error),signal:r.signal});
      const controls=()=>{
        const ignore=meta(cp.spawnSync(process.execPath,['child.cjs'],{stdio:'ignore'}));
        const inherit=meta(cp.spawnSync(process.execPath,['child.cjs'],{stdio:'inherit'}));
        const fd=fs.openSync('child-output.txt','w+');
        let file;
        try {file=meta(cp.spawnSync(process.execPath,['child.cjs'],{stdio:[fd,fd,fd]}));}
        finally {fs.closeSync(fd);}
        const ignoreSlots=[0,1,2].map((slot)=>{
          const stdio=['inherit','inherit','inherit'];stdio[slot]='ignore';
          return meta(cp.spawnSync(process.execPath,['-e','process.exit(0)'],{stdio}));
        });
        // Device opens have different flags from libuv's ignored-stdio CreateFile.
        // Never use bare NUL here: Node fs can resolve it as an ordinary file path.
        const nul=[fs.constants.O_RDONLY,fs.constants.O_WRONLY,fs.constants.O_RDWR].map((flags)=>{
          let fd;
          try {
            fd=fs.openSync(${JSON.stringify('\\\\.\\NUL')},flags);
            return {openCode:null,child:meta(cp.spawnSync(process.execPath,
              ['-e','process.exit(0)'],{stdio:[fd,fd,fd]}))};
          } catch(error) {return {openCode:code(error),child:null};}
          finally {if(fd!==undefined)fs.closeSync(fd);}
        });
        return {ignore,inherit,file,ignoreSlots,nul};
      };
    `;
    const script = `
      ${controlsSource}
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
      for(let slot=0;slot<3;slot++){
        const result=baseline.ignoreSlots[slot];
        a.ok(result.signal===null&&(
          (result.status===0&&result.code===null)||
          (result.status===null&&result.code==='EPERM')
        ),diagnostic);
        a.deepEqual(guarded.ignoreSlots[slot],result,diagnostic);
      }
      a.deepEqual(guarded.nul,baseline.nul,diagnostic);
      for(const group of [baseline,guarded]){
        a.deepEqual(group.inherit,{status:0,code:null,signal:null},diagnostic);
        a.deepEqual(group.file,{status:0,code:null,signal:null},diagnostic);
        for(const result of group.nul){
          if(result.openCode===null)a.deepEqual(result.child,{status:0,code:null,signal:null},diagnostic);
          else a.ok(['EPERM','EACCES'].includes(result.openCode)&&result.child===null,diagnostic);
        }
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
    await writeFile(
      join(workspace, 'guard-host-controls.cjs'),
      `${controlsSource}console.log(JSON.stringify(controls()));`,
    );
    const host = await exec(process.execPath, ['guard-host-controls.cjs'], {
      cwd: workspace,
      env: {
        ...env,
        SPRINT_CODER_SANDBOX_NODE_PIPE_GUARD: '0',
        NODE_OPTIONS: '--preserve-symlinks --preserve-symlinks-main',
      },
      windowsHide: true,
    });
    const hostObservation = JSON.parse(host.stdout.trim());
    for (const result of [
      hostObservation.ignore,
      hostObservation.inherit,
      hostObservation.file,
      ...hostObservation.ignoreSlots,
    ])
      expect(result).toEqual({ status: 0, code: null, signal: null });
    for (const result of hostObservation.nul)
      expect(result).toEqual({ openCode: null, child: { status: 0, code: null, signal: null } });
    console.info('Unsandboxed NUL controls:', JSON.stringify(hostObservation));
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
    expect((await exec('icacls.exe', [preload], { windowsHide: true })).stdout).toBe(initialAcl);
    // Preserve explicit owner/system/admin access while testing protected inheritance.
    // These are new, test-owned files; no user's security settings are modified.
    await exec('icacls.exe', [preload, '/inheritance:r'], { windowsHide: true });

    const descriptor = async (file: string) => {
      const powershell = join(
        process.env.SystemRoot!,
        'System32/WindowsPowerShell/v1.0/powershell.exe',
      );
      return (
        await exec(
          powershell,
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            `([System.IO.File]::GetAccessControl('${file.replaceAll("'", "''")}')).GetSecurityDescriptorSddlForm([System.Security.AccessControl.AccessControlSections]::Access)`,
          ],
          { windowsHide: true },
        )
      ).stdout.trim();
    };
    const ownerSid = (
      await exec(
        join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          '[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
        ],
        { windowsHide: true },
      )
    ).stdout.trim();
    expect(ownerSid).toMatch(/^S-1-5-21-[0-9-]+$/u);
    await exec(
      'icacls.exe',
      [preload, '/grant:r', '*S-1-5-18:F', '*S-1-5-32-544:F', `*${ownerSid}:F`],
      { windowsHide: true },
    );
    const protectedDescriptor = await descriptor(preload);
    const protectedAcl = (await exec('icacls.exe', [preload], { windowsHide: true })).stdout;
    expect(protectedDescriptor).toMatch(/D:P/u);
    expect(protectedDescriptor).toContain(';;;SY)');
    expect(protectedDescriptor).toContain(';;;BA)');
    expect(await readFile(preload)).toEqual(
      await readFile(join(build, 'sandbox-node-pipe-guard.cjs')),
    );
    const esm = await exec(runner, [...args, 'guard-accept.mjs'], {
      cwd: workspace,
      env,
      windowsHide: true,
      timeout: 20_000,
    });
    expect(esm.stdout.trim()).toBe('ESM_OK');
    expect(await descriptor(preload)).toBe(protectedDescriptor);
    await expect(
      exec(runner, [...args, 'npm-test.cjs'], {
        cwd: workspace,
        env,
        windowsHide: true,
        timeout: 20_000,
      }),
    ).rejects.toThrow('cannot create child-process pipes/IPC safely');
    const beforeAcl = (await exec('icacls.exe', [preload], { windowsHide: true })).stdout;
    expect(beforeAcl).toBe(protectedAcl);
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
    expect(await descriptor(preload)).toBe(protectedDescriptor);
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
    expect(await descriptor(`${preload}.disabled`)).toBe(protectedDescriptor);
    // Keep this isolated fixture for evidence. No user directory or external state is removed.
    expect(dirname(runner)).toBe(resources);
  }, 60_000);
});
