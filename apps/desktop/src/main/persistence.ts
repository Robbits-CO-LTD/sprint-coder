import Database from 'better-sqlite3';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  chatMessageSchema,
  taskSummarySchema,
  turnEventSchema,
  type ChatMessage,
  type TaskSummary,
  type TurnEvent,
  type TurnStage,
} from '@vibe/contracts';
import { transitionTurn, type TurnState } from '@vibe/domain';

type TaskRow = {
  id: string; title: string; pinned: number; archived: number; created_at: string; updated_at: string;
};
type MessageRow = {
  id: string; task_id: string; turn_id: string | null; author: ChatMessage['author']; content: string; created_at: string;
};
type TurnRow = { id: string; task_id: string; state: TurnState; seq: number; assistant_message_id: string | null };

const migrations = [{
  version: 1,
  checksum: 'chat-alpha-v1-tasks-messages-turns-events',
  sql: `
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
      archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      turn_id TEXT,
      author TEXT NOT NULL CHECK (author IN ('user', 'assistant', 'system')),
      content TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE turns (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      user_message_id TEXT NOT NULL REFERENCES messages(id),
      assistant_message_id TEXT REFERENCES messages(id),
      state TEXT NOT NULL,
      seq INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE turn_events (
      id TEXT PRIMARY KEY,
      turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      schema_version INTEGER NOT NULL DEFAULT 1,
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(turn_id, seq)
    );
    CREATE INDEX messages_task_created_idx ON messages(task_id, created_at, id);
    CREATE INDEX turns_task_state_idx ON turns(task_id, state);
  `,
}];

export interface PersistenceClient {
  listTasks(): TaskSummary[];
  createTask(title?: string): TaskSummary;
  renameTask(taskId: string, title: string): TaskSummary;
  listMessages(taskId: string): ChatMessage[];
  startTurn(taskId: string, text: string): { turnId: string; event: TurnEvent };
  changeStage(taskId: string, turnId: string, stage: TurnStage): TurnEvent;
  appendDelta(taskId: string, turnId: string, messageId: string, delta: string): TurnEvent;
  completeTurn(taskId: string, turnId: string, state: 'completed' | 'canceled' | 'failed' | 'interrupted'): TurnEvent;
  cancelTurn(taskId: string, turnId: string): TurnEvent | null;
  interruptActiveTurns(): number;
  close(): void;
}

export class SqlitePersistenceClient implements PersistenceClient {
  private readonly db: Database.Database;

  constructor(databasePath: string) {
    mkdirSync(dirname(databasePath), { recursive: true });
    this.db = new Database(databasePath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this.runMigrations(databasePath);
  }

  private runMigrations(databasePath: string): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL
    )`);
    const applied = new Map(
      (this.db.prepare('SELECT version, checksum FROM schema_migrations').all() as { version: number; checksum: string }[])
        .map((row) => [row.version, row.checksum]),
    );
    const pending = migrations.filter((migration) => !applied.has(migration.version));
    if (pending.length > 0 && existsSync(databasePath) && applied.size > 0) {
      copyFileSync(databasePath, `${databasePath}.pre-migration.bak`);
    }
    for (const migration of migrations) {
      const checksum = applied.get(migration.version);
      if (checksum !== undefined && checksum !== migration.checksum) throw new Error('Migration checksum mismatch');
      if (checksum !== undefined) continue;
      this.db.transaction(() => {
        this.db.exec(migration.sql);
        this.db.prepare('INSERT INTO schema_migrations(version, checksum, applied_at) VALUES (?, ?, ?)')
          .run(migration.version, migration.checksum, new Date().toISOString());
      })();
    }
  }

  listTasks(): TaskSummary[] {
    return (this.db.prepare('SELECT * FROM tasks WHERE archived = 0 ORDER BY pinned DESC, updated_at DESC').all() as TaskRow[])
      .map(toTask);
  }

  createTask(title = '新しいタスク'): TaskSummary {
    const now = new Date().toISOString();
    const task: TaskSummary = { id: randomUUID(), title, pinned: false, archived: false, createdAt: now, updatedAt: now };
    this.db.prepare('INSERT INTO tasks(id, title, pinned, archived, created_at, updated_at) VALUES (?, ?, 0, 0, ?, ?)')
      .run(task.id, task.title, now, now);
    return taskSummarySchema.parse(task);
  }

  renameTask(taskId: string, title: string): TaskSummary {
    const now = new Date().toISOString();
    const result = this.db.prepare('UPDATE tasks SET title = ?, updated_at = ? WHERE id = ?').run(title, now, taskId);
    if (result.changes !== 1) throw new NotFoundError('Task not found');
    return this.getTask(taskId);
  }

  listMessages(taskId: string): ChatMessage[] {
    this.assertTask(taskId);
    return (this.db.prepare('SELECT * FROM messages WHERE task_id = ? ORDER BY created_at, rowid').all(taskId) as MessageRow[])
      .map(toMessage);
  }

  startTurn(taskId: string, text: string): { turnId: string; event: TurnEvent } {
    return this.db.transaction(() => {
      this.assertTask(taskId);
      const now = new Date().toISOString();
      const turnId = randomUUID();
      const userMessage = chatMessageSchema.parse({
        id: randomUUID(), taskId, turnId, author: 'user', content: text, createdAt: now,
      });
      this.db.prepare('INSERT INTO messages(id, task_id, turn_id, author, content, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(userMessage.id, taskId, turnId, userMessage.author, userMessage.content, now);
      this.db.prepare('INSERT INTO turns(id, task_id, user_message_id, state, seq, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)')
        .run(turnId, taskId, userMessage.id, 'queued', now, now);
      const event = turnEventSchema.parse({ type: 'turn.accepted', taskId, turnId, seq: 1, userMessage });
      this.insertEvent(event);
      this.db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(now, taskId);
      return { turnId, event };
    })();
  }

  changeStage(taskId: string, turnId: string, stage: TurnStage): TurnEvent {
    return this.db.transaction(() => {
      const turn = this.getTurn(taskId, turnId);
      transitionTurn(turn.state, stage);
      const seq = turn.seq + 1;
      this.updateTurn(turnId, stage, seq);
      const event = turnEventSchema.parse({ type: 'stage.changed', taskId, turnId, seq, stage });
      this.insertEvent(event);
      return event;
    })();
  }

  appendDelta(taskId: string, turnId: string, messageId: string, delta: string): TurnEvent {
    return this.db.transaction(() => {
      const turn = this.getTurn(taskId, turnId);
      if (turn.state !== 'synthesizing') throw new Error('Turn is not streaming');
      const now = new Date().toISOString();
      if (turn.assistant_message_id === null) {
        this.db.prepare('INSERT INTO messages(id, task_id, turn_id, author, content, created_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(messageId, taskId, turnId, 'assistant', delta, now);
        this.db.prepare('UPDATE turns SET assistant_message_id = ? WHERE id = ?').run(messageId, turnId);
      } else {
        if (turn.assistant_message_id !== messageId) throw new Error('Assistant message identity mismatch');
        this.db.prepare('UPDATE messages SET content = content || ? WHERE id = ?').run(delta, messageId);
      }
      const seq = turn.seq + 1;
      this.updateTurn(turnId, turn.state, seq);
      const event = turnEventSchema.parse({ type: 'message.delta', taskId, turnId, seq, messageId, delta });
      this.insertEvent(event);
      return event;
    })();
  }

  completeTurn(taskId: string, turnId: string, state: 'completed' | 'canceled' | 'failed' | 'interrupted'): TurnEvent {
    return this.db.transaction(() => this.completeTurnInTransaction(taskId, turnId, state))();
  }

  cancelTurn(taskId: string, turnId: string): TurnEvent | null {
    return this.db.transaction(() => {
      const turn = this.getTurn(taskId, turnId);
      if (['completed', 'canceled', 'failed', 'interrupted'].includes(turn.state)) return null;
      transitionTurn(turn.state, 'canceling');
      this.updateTurn(turnId, 'canceling', turn.seq);
      return this.completeTurnInTransaction(taskId, turnId, 'canceled');
    })();
  }

  interruptActiveTurns(): number {
    return this.db.transaction(() => {
      const turns = this.db.prepare(`SELECT * FROM turns WHERE state IN
        ('queued', 'understanding', 'planning', 'executing', 'synthesizing', 'canceling')`).all() as TurnRow[];
      for (const turn of turns) this.completeTurnInTransaction(turn.task_id, turn.id, 'interrupted');
      return turns.length;
    })();
  }

  close(): void { this.db.close(); }

  private completeTurnInTransaction(
    taskId: string,
    turnId: string,
    state: 'completed' | 'canceled' | 'failed' | 'interrupted',
  ): TurnEvent {
    const turn = this.getTurn(taskId, turnId);
    transitionTurn(turn.state, state);
    const seq = turn.seq + 1;
    this.updateTurn(turnId, state, seq);
    const row = turn.assistant_message_id === null ? undefined : this.db.prepare('SELECT * FROM messages WHERE id = ?')
      .get(turn.assistant_message_id) as MessageRow | undefined;
    const base = { type: 'turn.completed' as const, taskId, turnId, seq, state };
    const event = turnEventSchema.parse(row === undefined ? base : { ...base, message: toMessage(row) });
    this.insertEvent(event);
    return event;
  }

  private updateTurn(turnId: string, state: TurnState, seq: number): void {
    this.db.prepare('UPDATE turns SET state = ?, seq = ?, updated_at = ? WHERE id = ?')
      .run(state, seq, new Date().toISOString(), turnId);
  }

  private insertEvent(event: TurnEvent): void {
    this.db.prepare('INSERT INTO turn_events(id, turn_id, seq, schema_version, type, payload_json, created_at) VALUES (?, ?, ?, 1, ?, ?, ?)')
      .run(randomUUID(), event.turnId, event.seq, event.type, JSON.stringify(event), new Date().toISOString());
  }

  private getTask(taskId: string): TaskSummary {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as TaskRow | undefined;
    if (row === undefined) throw new NotFoundError('Task not found');
    return toTask(row);
  }

  private assertTask(taskId: string): void { this.getTask(taskId); }

  private getTurn(taskId: string, turnId: string): TurnRow {
    const row = this.db.prepare('SELECT * FROM turns WHERE id = ? AND task_id = ?').get(turnId, taskId) as TurnRow | undefined;
    if (row === undefined) throw new NotFoundError('Turn not found');
    return row;
  }
}

export class NotFoundError extends Error {}

function toTask(row: TaskRow): TaskSummary {
  return taskSummarySchema.parse({
    id: row.id, title: row.title, pinned: row.pinned === 1, archived: row.archived === 1,
    createdAt: row.created_at, updatedAt: row.updated_at,
  });
}

function toMessage(row: MessageRow): ChatMessage {
  return chatMessageSchema.parse({
    id: row.id, taskId: row.task_id, turnId: row.turn_id, author: row.author,
    content: row.content, createdAt: row.created_at,
  });
}
