const { createRequire } = require('node:module');
const { join, resolve } = require('node:path');
const { existsSync, readdirSync, statSync } = require('node:fs');
const lane = resolve(process.argv[2]);
const dependencies = createRequire(join(resolve(process.argv[3]), 'package.json'));
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
