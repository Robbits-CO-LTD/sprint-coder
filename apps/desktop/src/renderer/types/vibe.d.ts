// Contract shared with Main/Preload (owned by backend team). Renderer only consumes this shape.
// Keep in sync with docs/PRODUCT_AND_TECHNICAL_DESIGN.md and the preload implementation.

export type TaskSummary = {
  id: string;
  title: string;
  pinned: boolean;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ChatMessage = {
  id: string;
  taskId: string;
  turnId: string | null;
  author: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: string;
};

export type TurnStage = 'understanding' | 'planning' | 'executing' | 'synthesizing';

export type TurnEvent =
  | { type: 'turn.accepted'; taskId: string; turnId: string; seq: number; userMessage: ChatMessage }
  | { type: 'stage.changed'; taskId: string; turnId: string; seq: number; stage: TurnStage }
  | { type: 'message.delta'; taskId: string; turnId: string; seq: number; messageId: string; delta: string }
  | {
      type: 'turn.completed';
      taskId: string;
      turnId: string;
      seq: number;
      state: 'completed' | 'canceled' | 'failed' | 'interrupted';
      message?: ChatMessage;
    };

export interface VibeApi {
  app: { getInfo(): Promise<{ version: string; platform: string }> };
  tasks: {
    list(): Promise<TaskSummary[]>;
    create(input?: { title?: string }): Promise<TaskSummary>;
    messages(taskId: string): Promise<ChatMessage[]>;
    rename(taskId: string, title: string): Promise<TaskSummary>;
  };
  turns: {
    start(input: { taskId: string; text: string }): Promise<{ turnId: string }>;
    cancel(input: { taskId: string; turnId: string }): Promise<void>;
    subscribe(taskId: string, cb: (ev: TurnEvent) => void): () => void; // returns unsubscribe
  };
}

declare global {
  interface Window {
    vibe?: VibeApi;
  }
}

export {};
