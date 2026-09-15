const { createRequire } = require('node:module');
const { join } = require('node:path');
const { existsSync, readdirSync, statSync } = require('node:fs');
const { assertOwnedLane } = require('./dflash-windows-guard.cjs');
const { lane, dependencyRoot } = assertOwnedLane(process.argv[2], process.argv[3]);
const dependencies = createRequire(join(dependencyRoot, 'package.json'));
const Database = dependencies('better-sqlite3');
const db = new Database(join(lane, 'profile', 'sprint-coder.sqlite3'), {
  readonly: true,
  fileMustExist: true,
});
try {
  const models = db
    .prepare('SELECT id, state FROM local_models WHERE source_id IN (?, ?)')
    .all('unsloth/Qwen3.8-27B-GGUF', 'incoai/Qwen3.8-27B-DFlash2-GGUF');
  for (const model of models) {
    const root = join(lane, 'profile', 'local-models', 'models', model.id);
    model.directoryExists = existsSync(root);
    model.artifactSizes = existsSync(root)
      ? readdirSync(root).map((name) => statSync(join(root, name)).size)
      : [];
  }
  console.log(JSON.stringify({ models }));
} finally {
  db.close();
}
