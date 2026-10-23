import Database from 'better-sqlite3';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { SqlitePersistenceClient } from './persistence';
import { electronTestExecutablePath } from './electron-test-runtime';
import { MainProviderRegistry, DeterministicMockProviderRuntime } from './provider-runtime';
import { RetiredManagedLocalError } from './retired-managed-local';
import { localProviderTestConnection } from './provider-connection-test-fixture';

const stamp = '2026-10-23T00:00:00.000Z';
const savedSelection = {
  connectionId: 'managed-local:runtime',
  requestedProvider: 'sprint-managed-local',
  requestedModel: 'a'.repeat(64),
};

function snapshot(path: string): unknown {
  const db = new Database(path, { readonly: true });
  try {
    return {
      models: db.prepare('SELECT * FROM local_models ORDER BY id').all(),
      artifacts: db.prepare('SELECT * FROM local_model_artifacts ORDER BY model_id, ordinal').all(),
      jobs: db.prepare('SELECT * FROM local_model_download_jobs ORDER BY id').all(),
      verifications: db.prepare('SELECT * FROM local_model_verifications ORDER BY model_id').all(),
      settings: db
        .prepare("SELECT * FROM settings WHERE key LIKE 'managed-local.%' ORDER BY key")
        .all(),
      migrations: db
        .prepare(
          'SELECT * FROM schema_migrations WHERE version IN (75, 76, 77, 83) ORDER BY version',
        )
        .all(),
    };
  } finally {
    db.close();
  }
}

if (process.env.SPRINT_CODER_ELECTRON_DB_TEST === '1') {
  describe('retired Managed Local data compatibility', () => {
    it('preserves installed/partial model bytes, metadata and selection across restart and catalog reconciliation', () => {
      const directory = mkdtempSync(join(tmpdir(), 'sprint-coder-retired-models-'));
      const path = join(directory, 'app.sqlite3');
      const modelRoot = join(directory, 'local-models');
      const installedRoot = join(modelRoot, 'models', savedSelection.requestedModel);
      const partialRoot = join(modelRoot, 'partials');
      mkdirSync(installedRoot, { recursive: true });
      mkdirSync(partialRoot, { recursive: true });
      const installedFile = join(installedRoot, '001.gguf');
      const partialFile = join(partialRoot, `${'b'.repeat(64)}-001.partial`);
      const installedBytes = Buffer.from('installed user model sentinel');
      const partialBytes = Buffer.from('partial download sentinel');
      writeFileSync(installedFile, installedBytes);
      writeFileSync(partialFile, partialBytes);
      let persistence: SqlitePersistenceClient | undefined;
      try {
        persistence = new SqlitePersistenceClient(path);
        persistence.createProviderConnection({
          ...localProviderTestConnection(),
          id: savedSelection.connectionId,
          providerId: savedSelection.requestedProvider,
          displayName: 'Managed Local',
        });
        const task = persistence.createTask('Saved local model task');
        persistence.setRuntime('codex');
        persistence.setTaskModelSelection(task.id, savedSelection);
        persistence.close();
        persistence = undefined;
        const db = new Database(path);
        try {
          for (const [id, state, bytes, jobState] of [
            ['a'.repeat(64), 'installed', installedBytes, 'installed'],
            ['b'.repeat(64), 'installing', partialBytes, 'verifying'],
          ] as const) {
            db.prepare(
              `INSERT INTO local_models(id, source, source_id, immutable_revision,
              quantization, artifact_count, total_bytes, state, created_at, updated_at, purpose, base_model_id)
              VALUES (?, 'hugging_face', 'saved/model', ?, 'Q4_K_M', 1, ?, ?, ?, ?, 'normal', 'saved/base')`,
            ).run(id, 'c'.repeat(40), bytes.length, state, stamp, stamp);
            db.prepare(
              `INSERT INTO local_model_artifacts(model_id, ordinal, filename, sha256,
              byte_length, downloaded_bytes, state, role) VALUES (?, 1, 'saved.gguf', ?, ?, ?, ?, 'model')`,
            ).run(
              id,
              createHash('sha256').update(bytes).digest('hex'),
              bytes.length,
              bytes.length,
              state === 'installed' ? 'installed' : 'downloaded',
            );
            db.prepare(
              `INSERT INTO local_model_download_jobs(id, model_id, state, downloaded_bytes,
              created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
            ).run(`job-${id}`, id, jobState, bytes.length, stamp, stamp);
          }
          db.prepare(
            `INSERT INTO local_model_verifications(model_id, level, verified_at, binding_json)
            VALUES (?, 'loaded', ?, '{}')`,
          ).run(savedSelection.requestedModel, stamp);
          for (const key of ['launch-settings', 'inference-settings', 'speculative-settings'])
            db.prepare('INSERT INTO settings(key, value, updated_at) VALUES (?, ?, ?)').run(
              `managed-local.${key}`,
              JSON.stringify({ [savedSelection.requestedModel]: { saved: true } }),
              stamp,
            );
          expect(
            db
              .prepare(
                'SELECT version, checksum FROM schema_migrations WHERE version IN (75,76,77,83) ORDER BY version',
              )
              .all(),
          ).toEqual([
            { version: 75, checksum: 'managed-local-download-store-secure-v75' },
            { version: 76, checksum: 'managed-local-verification-v76' },
            { version: 77, checksum: 'managed-local-mmproj-artifact-role-v77' },
            { version: 83, checksum: 'managed-local-v83-model-purpose' },
          ]);
        } finally {
          db.close();
        }
        const before = snapshot(path);
        persistence = new SqlitePersistenceClient(path);
        persistence.reconcileBuiltinModelCatalog('codex', ['auto', 'available-cloud-cli-model']);
        expect(persistence.getTask(task.id).title).toBe('Saved local model task');
        expect(persistence.getTaskModelSelection(task.id)).toEqual(savedSelection);
        expect(persistence.getImageAttachmentAcceptanceSelection(task.id).modelSelection).toEqual(
          savedSelection,
        );
        const registry = new MainProviderRegistry();
        registry.register({
          runtimeKind: 'openai_compatible',
          providerId: null,
          runtime: new DeterministicMockProviderRuntime(),
        });
        expect(() =>
          registry.resolve(persistence!.getProviderConnection(savedSelection.connectionId)),
        ).toThrow(RetiredManagedLocalError);
        persistence.close();
        persistence = undefined;
        expect(snapshot(path)).toEqual(before);
        expect(readFileSync(installedFile)).toEqual(installedBytes);
        expect(readFileSync(partialFile)).toEqual(partialBytes);
      } finally {
        persistence?.close();
        rmSync(directory, { recursive: true, force: true });
      }
    });
  });
} else {
  it('checks legacy Managed Local data with the bundled Electron SQLite ABI', async () => {
    await promisify(execFile)(
      electronTestExecutablePath(),
      [
        join(process.cwd(), '../../node_modules/vitest/vitest.mjs'),
        'run',
        'src/main/retired-managed-local-persistence.test.ts',
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', SPRINT_CODER_ELECTRON_DB_TEST: '1' },
        timeout: 60_000,
        maxBuffer: 2 * 1024 * 1024,
      },
    );
  }, 65_000);
}
