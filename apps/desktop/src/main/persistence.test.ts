import Database from 'better-sqlite3';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  OperationConflictError,
  SqlitePersistenceClient,
  SteerStaleError,
  TurnActiveError,
} from './persistence';

const cleanup: string[] = [];
const runsWithElectronAbi = process.env.VIBE_ELECTRON_DB_TEST === '1';

afterEach(() => {
  for (const directory of cleanup.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function createPersistence(): { persistence: SqlitePersistenceClient; path: string } {
  const directory = mkdtempSync(join(tmpdir(), 'vibe-persistence-'));
  cleanup.push(directory);
  const path = join(directory, 'test.sqlite3');
  return { persistence: new SqlitePersistenceClient(path), path };
}

if (runsWithElectronAbi)
  describe('SqlitePersistenceClient v4', () => {
    it('deduplicates operations and rejects operation id hash conflicts', () => {
      const { persistence } = createPersistence();
      let calls = 0;
      const first = persistence.executeOperation(
        'renderer:1',
        '',
        'tasks.create',
        'op-1',
        'hash-a',
        () => {
          calls += 1;
          return persistence.createTask('deduplicated');
        },
      );
      const replayed = persistence.executeOperation(
        'renderer:1',
        '',
        'tasks.create',
        'op-1',
        'hash-a',
        () => {
          calls += 1;
          return persistence.createTask('should not run');
        },
      );

      expect(replayed).toEqual(first);
      expect(calls).toBe(1);
      expect(persistence.listTasks()).toHaveLength(1);
      expect(() =>
        persistence.executeOperation(
          'renderer:1',
          '',
          'tasks.create',
          'op-1',
          'hash-b',
          () => null,
        ),
      ).toThrow(OperationConflictError);
      persistence.close();
    });

    it('uses one monotonic sequence for all task events and replays strictly after afterSeq', () => {
      const { persistence } = createPersistence();
      const task = persistence.createTask();
      const first = persistence.startTurn(task.id, 'first');
      const queued = persistence.queueInput(task.id, 'second', 'queue-op');
      const stage = persistence.changeStage(task.id, first.turnId, 'understanding');
      const canceled = persistence.cancelTurn(task.id, first.turnId);
      const all = persistence.listEventsAfter(task.id, 0);

      expect([first.event.seq, queued.event.seq, stage.seq, canceled?.seq]).toEqual([1, 2, 3, 4]);
      expect(all.map((event) => event.seq)).toEqual([1, 2, 3, 4]);
      expect(persistence.listEventsAfter(task.id, 2).map((event) => event.seq)).toEqual([3, 4]);
      persistence.close();
    });

    it('rejects a second active turn and dequeues queued input in ordinal order', () => {
      const { persistence } = createPersistence();
      const task = persistence.createTask();
      const active = persistence.startTurn(task.id, 'active');
      expect(() => persistence.startTurn(task.id, 'parallel')).toThrow(TurnActiveError);
      expect(persistence.queueInput(task.id, 'queued one', 'q1').ordinal).toBe(1);
      expect(persistence.queueInput(task.id, 'queued two', 'q2').ordinal).toBe(2);

      persistence.cancelTurn(task.id, active.turnId);
      const transition = persistence.startNextQueued(task.id);
      expect(transition?.started.text).toBe('queued one');
      expect(transition?.queueEvent).toMatchObject({
        type: 'queue.changed',
        queued: [{ ordinal: 2, text: 'queued two' }],
      });
      expect(persistence.snapshot(task.id).queued).toEqual([{ ordinal: 2, text: 'queued two' }]);
      persistence.close();
    });

    it('persists valid steering as a user message and rejects stale expectedTurnId', () => {
      const { persistence } = createPersistence();
      const task = persistence.createTask();
      const active = persistence.startTurn(task.id, 'original');

      expect(() => persistence.steerTurn(task.id, 'stale', 'wrong-turn')).toThrow(SteerStaleError);
      persistence.steerTurn(task.id, '追加条件', active.turnId);
      expect(
        persistence.listMessages(task.id).map((message) => [message.author, message.content]),
      ).toEqual([
        ['user', 'original'],
        ['user', '追加条件'],
      ]);
      persistence.close();
    });

    it('keeps queued input across restart and exposes task attributes and snapshots', () => {
      const { persistence, path } = createPersistence();
      const task = persistence.createTask('attributes');
      persistence.setPinned(task.id, true);
      persistence.setGoal(task.id, 'goal');
      persistence.setDraft(task.id, 'draft');
      persistence.setWorkspace(task.id, '/tmp/workspace');
      persistence.queueInput(task.id, 'resume me', 'q1');
      persistence.close();

      const reopened = new SqlitePersistenceClient(path);
      expect(reopened.listTasks()[0]).toMatchObject({
        pinned: true,
        goal: 'goal',
        workspacePath: '/tmp/workspace',
      });
      expect(reopened.getDraft(task.id)).toBe('draft');
      expect(reopened.snapshot(task.id)).toMatchObject({
        activeTurn: null,
        queued: [{ ordinal: 1, text: 'resume me' }],
      });
      expect(reopened.startNextQueued(task.id)?.started.text).toBe('resume me');
      reopened.close();
    });

    it('defaults to mock and persists the selected runtime across restart', () => {
      const { persistence, path } = createPersistence();
      expect(persistence.getRuntime()).toBe('mock');
      persistence.setRuntime('codex');
      persistence.close();

      const reopened = new SqlitePersistenceClient(path);
      expect(reopened.getRuntime()).toBe('codex');
      reopened.close();
    });

    it('publishes context usage around audit-only compaction without changing displayed history', () => {
      const { persistence, path } = createPersistence();
      const task = persistence.createTask();
      persistence.setGoal(task.id, 'Keep the answer deterministic');
      const original = 'x'.repeat(76_803);
      const started = persistence.startTurn(task.id, original);
      const prepared = persistence.prepareContext(task.id, started.turnId);

      expect(prepared.compacted).toBe(true);
      expect(prepared.usageEvents.map((event) => [event.type, event.seq])).toEqual([
        ['context.usage', 2],
        ['context.usage', 4],
      ]);
      expect(persistence.listMessages(task.id)).toHaveLength(1);
      expect(persistence.listMessages(task.id)[0]?.content).toBe(original);
      expect(
        persistence.listEventsAfter(task.id, 0).map((event) => [event.type, event.seq]),
      ).toEqual([
        ['turn.accepted', 1],
        ['context.usage', 2],
        ['context.usage', 4],
      ]);
      expect(persistence.snapshot(task.id)).toMatchObject({
        lastSeq: 4,
        contextUsage:
          prepared.usageEvents[1]?.type === 'context.usage'
            ? prepared.usageEvents[1].usage
            : undefined,
      });
      persistence.close();

      const db = new Database(path, { readonly: true });
      expect(
        db
          .prepare("SELECT COUNT(*) AS count FROM turn_events WHERE type = 'context.compacted'")
          .get(),
      ).toEqual({ count: 1 });
      expect(
        db
          .prepare(
            'SELECT COUNT(*) AS count FROM context_fragments WHERE superseded_by_compaction_id IS NOT NULL',
          )
          .get(),
      ).toEqual({ count: 1 });
      db.close();
    });

    it('migrates a v1 database with duplicate active turns without crashing', () => {
      const directory = mkdtempSync(join(tmpdir(), 'vibe-migration-'));
      cleanup.push(directory);
      const path = join(directory, 'legacy.sqlite3');
      createLegacyV1Database(path);

      const persistence = new SqlitePersistenceClient(path);
      expect(persistence.interruptActiveTurns()).toBe(1);
      expect(persistence.listEventsAfter('task-1', 0).map((event) => event.seq)).toEqual([1, 2, 3]);
      persistence.close();

      const migrated = new Database(path, { readonly: true });
      expect(
        migrated.prepare('SELECT version FROM schema_migrations ORDER BY version').all(),
      ).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }]);
      expect(
        migrated
          .prepare('PRAGMA table_info(context_fragments)')
          .all()
          .map((column) => (column as { name: string }).name),
      ).toEqual([
        'id',
        'task_id',
        'source',
        'trust',
        'token_estimate',
        'created_at',
        'superseded_by_compaction_id',
        'message_id',
      ]);
      migrated.close();
    });
  });
else
  describe('SqlitePersistenceClient v4 Electron ABI bridge', () => {
    it('runs the SQLite integration suite with the bundled Electron Node ABI', () => {
      const result = spawnSync(
        join(process.cwd(), '../../node_modules/.bin/electron'),
        [
          join(process.cwd(), '../../node_modules/vitest/vitest.mjs'),
          'run',
          'src/main/persistence.test.ts',
        ],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', VIBE_ELECTRON_DB_TEST: '1' },
          timeout: 30_000,
        },
      );
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    }, 35_000);
  });

function createLegacyV1Database(path: string): void {
  const db = new Database(path);
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL);
    INSERT INTO schema_migrations VALUES (1, 'chat-alpha-v1-tasks-messages-turns-events', '2026-01-01T00:00:00.000Z');
    CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL, pinned INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE messages (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      turn_id TEXT, author TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE turns (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      user_message_id TEXT NOT NULL REFERENCES messages(id), assistant_message_id TEXT REFERENCES messages(id),
      state TEXT NOT NULL, seq INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE turn_events (id TEXT PRIMARY KEY, turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL, schema_version INTEGER NOT NULL DEFAULT 1, type TEXT NOT NULL,
      payload_json TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(turn_id, seq));
    CREATE INDEX messages_task_created_idx ON messages(task_id, created_at, id);
    CREATE INDEX turns_task_state_idx ON turns(task_id, state);
    INSERT INTO tasks VALUES ('task-1', 'legacy', 0, 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    INSERT INTO messages VALUES ('message-1', 'task-1', 'turn-1', 'user', 'one', '2026-01-01T00:00:00.000Z');
    INSERT INTO messages VALUES ('message-2', 'task-1', 'turn-2', 'user', 'two', '2026-01-01T00:00:01.000Z');
    INSERT INTO turns VALUES ('turn-1', 'task-1', 'message-1', NULL, 'queued', 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    INSERT INTO turns VALUES ('turn-2', 'task-1', 'message-2', NULL, 'queued', 0, '2026-01-01T00:00:01.000Z', '2026-01-01T00:00:01.000Z');
    INSERT INTO turn_events VALUES (
      'event-1', 'turn-1', 1, 1, 'turn.accepted',
      '{"type":"turn.accepted","taskId":"task-1","turnId":"turn-1","seq":1,"userMessage":{"id":"message-1","taskId":"task-1","turnId":"turn-1","author":"user","content":"one","createdAt":"2026-01-01T00:00:00.000Z"}}',
      '2026-01-01T00:00:00.000Z'
    );
    INSERT INTO turn_events VALUES (
      'event-2', 'turn-2', 1, 1, 'turn.accepted',
      '{"type":"turn.accepted","taskId":"task-1","turnId":"turn-2","seq":1,"userMessage":{"id":"message-2","taskId":"task-1","turnId":"turn-2","author":"user","content":"two","createdAt":"2026-01-01T00:00:01.000Z"}}',
      '2026-01-01T00:00:01.000Z'
    );
  `);
  db.close();
}
