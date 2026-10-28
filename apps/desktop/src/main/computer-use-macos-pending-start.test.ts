import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// The target is this child process with a deliberately mismatching executable path. Production
// start rejects it before any window lookup or activation. No AX settings, GUI or input is used.
describe.skipIf(process.platform !== 'darwin')('macOS pending-start terminal receipts', () => {
  it('retains failed admissions, drains queued starts and keeps terminal replay owner-scoped', () => {
    const repository = resolve(__dirname, '../../../..');
    const root = mkdtempSync(join(tmpdir(), 'computer-pending-start-'));
    try {
      execFileSync(process.execPath, [join(repository, 'build-computer-use-native.mjs')], {
        cwd: repository,
        timeout: 120_000,
        stdio: 'pipe',
      });
      const script = join(root, 'check.cjs');
      writeFileSync(script, program);
      const artifact = join(
        repository,
        'apps/desktop/computer-use-native/build/Release/sprint_coder_computer_use_native.node',
      );
      const output = execFileSync(process.execPath, [script, artifact, root], {
        env: { ...process.env, UV_THREADPOOL_SIZE: '1' },
        encoding: 'utf8',
        timeout: 15_000,
      });
      expect(JSON.parse(output)).toEqual({
        queuedStops: 3,
        failedStarts: 18,
        capacityRefused: true,
        unknownRefused: true,
        inputAttempts: 0,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 140_000);
});

const program = String.raw`
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const addon = require(process.argv[2]);
const root = process.argv[3];
const watchdog = setTimeout(() => process.exit(42), 12000);
const input = sessionId => ({pid:process.pid,windowId:1,sessionId,taskId:'task',turnId:'turn',appIdentityDigest:'a'.repeat(64),windowIdentityDigest:'b'.repeat(64),canonicalPath:'/__sprint_coder_nonexistent_identity__',expectedBoundsX:0,expectedBoundsY:0,expectedBoundsWidth:100,expectedBoundsHeight:100,cancelEpoch:0});
async function rejected(run, code) {
  let error;
  try { await run(); } catch (caught) { error=caught; }
  assert.equal(error?.code, code);
}
function receipt(value, id) {
  assert.equal(value.result,'closed');assert.equal(value.drained,true);assert.equal(value.sessionId,id);
  assert.equal(value.inputAttemptCount,0);assert.ok(Number.isSafeInteger(value.cancelEpoch));
  return value.cancelEpoch;
}
async function queuedStop(id) {
  const fifo=path.join(root,id+'.fifo');execFileSync('/usr/bin/mkfifo',[fifo]);
  const reader = new Promise((resolve,reject)=>fs.open(fifo,'r',(error,fd)=>{if(error)reject(error);else{fs.closeSync(fd);resolve();}}));
  // One libuv worker is held by the FIFO open, so both production native workers remain queued.
  const starting=rejected(()=>addon.startSession(input(id)),'CANCELED');
  let settled=false;
  const stopping=Promise.resolve(addon.stopPendingStart({sessionId:id})).then(value=>{settled=true;return value;});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(settled,false);
  const writer=fs.openSync(fifo,'w');fs.closeSync(writer);
  await reader;await starting;
  const result=await stopping;receipt(result,id);fs.unlinkSync(fifo);return result;
}
(async()=>{
  assert.equal(addon.probe().apiVersion,3);
  await rejected(()=>addon.stopPendingStart({sessionId:'unknown'}),'SESSION_MISSING');
  await rejected(()=>addon.stopPendingStart({sessionId:'unknown',cancelEpoch:100}),'INVALID_SESSION');
  const first=await queuedStop('queued-first');
  await rejected(()=>addon.startSession(input('queued-first')),'SESSION_ID_REUSE');
  await rejected(()=>addon.close({sessionId:'queued-first',cancelEpoch:first.cancelEpoch}),'INVALID_CANCEL');
  await rejected(()=>addon.startSession(input('failed')),'APP_IDENTITY_CHANGED');
  const failed=await addon.stopPendingStart({sessionId:'failed'});receipt(failed,'failed');
  const replay=await addon.stopPendingStart({sessionId:'failed'});receipt(replay,'failed');
  assert.ok(replay.cancelEpoch>failed.cancelEpoch);
  const second=await queuedStop('queued-second');
  // Closing/replaying an inactive failed lifetime must not advance the process-global epoch.
  assert.equal(second.cancelEpoch,first.cancelEpoch+1);
  const longest='x'.repeat(256);
  await rejected(()=>addon.startSession(input(longest)),'APP_IDENTITY_CHANGED');
  receipt(await addon.stopPendingStart({sessionId:longest}),longest);
  await rejected(()=>addon.startSession(input('x'.repeat(257))),'INVALID_SESSION');
  await rejected(()=>addon.stopPendingStart({sessionId:'x'.repeat(257)}),'INVALID_SESSION');
  const inherited=Object.create({sessionId:'unknown'});inherited.extra=true;
  await rejected(()=>addon.stopPendingStart(inherited),'INVALID_SESSION');
  for(let i=0;i<16;i++)await rejected(()=>addon.startSession(input('capacity-'+i)),'APP_IDENTITY_CHANGED');
  await rejected(()=>addon.startSession(input('capacity-overflow')),'SESSION_LIMIT');
  await rejected(()=>addon.stopPendingStart({sessionId:'capacity-overflow'}),'SESSION_MISSING');
  for(let i=0;i<16;i++)receipt(await addon.stopPendingStart({sessionId:'capacity-'+i}),'capacity-'+i);
  const third=await queuedStop('queued-after-capacity');assert.equal(third.cancelEpoch,second.cancelEpoch+1);
  console.log(JSON.stringify({queuedStops:3,failedStarts:18,capacityRefused:true,unknownRefused:true,inputAttempts:0}));
})().then(()=>clearTimeout(watchdog),error=>{console.error(error);clearTimeout(watchdog);process.exitCode=1;});
`;
