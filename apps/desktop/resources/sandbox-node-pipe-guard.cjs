'use strict';

// A compatibility diagnostic, not a security boundary. The AppContainer remains the boundary.
// The host Job wrapper never loads this file; only its sandboxed command inherits the marker.
if (process.platform === 'win32' && process.env.SPRINT_CODER_SANDBOX_NODE_PIPE_GUARD === '1') {
  const uv = process.versions.uv.split('.').map(Number);
  if (uv[0] < 1 || (uv[0] === 1 && uv[1] < 53)) {
    const cp = require('node:child_process');
    const reject = () => {
      const error = new Error(
        `Windows command sandbox: Node libuv ${process.versions.uv} cannot create child-process pipes/IPC safely. Use stdio 'ignore' or 'inherit' without IPC, run the test in-process, or use Node with libuv >= 1.53.0.`,
      );
      error.code = 'SPRINT_CODER_SANDBOX_NODE_PIPE_UNSUPPORTED';
      throw error;
    };
    const hasPipe = (stdio) => {
      if (stdio === undefined || stdio === null || stdio === 'pipe' || stdio === 'overlapped')
        return true;
      if (!Array.isArray(stdio)) return false; // Node validates other string/invalid options itself.
      return [0, 1, 2, ...stdio.slice(3).map((_, index) => index + 3)].some((index) => {
        const entry = stdio[index];
        return (
          entry === 'pipe' ||
          entry === 'ipc' ||
          entry === 'overlapped' ||
          (index < 3 && (entry === undefined || entry === null))
        );
      });
    };
    const spawn = cp.ChildProcess.prototype.spawn;
    cp.ChildProcess.prototype.spawn = function (options) {
      const snapshot = { ...options };
      if (hasPipe(snapshot.stdio)) reject();
      return Reflect.apply(spawn, this, [snapshot]);
    };
    for (const [name, optionIndex] of [
      ['spawnSync', 2],
      ['execFileSync', 2],
      ['execSync', 1],
    ]) {
      const original = cp[name];
      cp[name] = function (...args) {
        const index = optionIndex === 2 && !Array.isArray(args[1]) ? 1 : optionIndex;
        const options = args[index];
        if (options === undefined || options === null) reject();
        // Evaluate option getters once, then give Node that same snapshot.
        const snapshot = typeof options === 'object' ? { ...options } : options;
        if (hasPipe(snapshot.stdio)) reject();
        args[index] = snapshot;
        return Reflect.apply(original, this, args);
      };
    }
    require('node:module').syncBuiltinESMExports();
  }
}
