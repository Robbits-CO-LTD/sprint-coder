// Preserve stdin/stdout for the GUI-subsystem fixture without attaching a console to it.
import { spawn } from 'node:child_process';
import console from 'node:console';
import process from 'node:process';
import { createWriteStream } from 'node:fs';
import { basename, resolve } from 'node:path';

const [binary, evidence, ...args] = process.argv.slice(2);
if (!binary || !evidence || !['fixture.exe', 'observer.exe'].includes(basename(binary)))
  throw new Error(
    'Usage: node run-background-input-tool.mjs <fixture.exe|observer.exe> <evidence.jsonl>',
  );
const output = createWriteStream(resolve(evidence), { flags: 'wx' });
output.once('open', () => {
  const child = spawn(resolve(binary), args, {
    stdio: ['pipe', 'pipe', 'inherit'],
    windowsHide: true,
  });
  process.stdin.pipe(child.stdin);
  child.stdout.pipe(output);
  child.stdin.on('error', (error) => {
    if (error.code !== 'EPIPE') throw error;
  });
  child.once('error', (error) => {
    console.error(error.message);
    output.end();
    process.stdin.pause();
    process.exitCode = 1;
  });
  child.once('close', (code) => {
    process.stdin.unpipe(child.stdin);
    process.stdin.pause();
    process.exitCode = code ?? 1;
  });
  // End only the child this runner created; normal shutdown uses quit/stop over stdin.
  process.once('SIGINT', () => {
    child.kill();
  });
});
output.once('error', (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
