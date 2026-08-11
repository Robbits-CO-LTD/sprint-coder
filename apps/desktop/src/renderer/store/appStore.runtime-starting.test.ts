import { beforeEach, describe, expect, it } from 'vitest';
import { handleTurnEvent, useAppStore } from './appStore';

const taskId = 'task-runtime-starting';

function applyEvent(event: Parameters<typeof handleTurnEvent>[1]): void {
  handleTurnEvent(taskId, event, (update) => useAppStore.setState((state) => update(state)));
}

describe('Runtime starting projection', () => {
  beforeEach(() => {
    useAppStore.setState({
      messagesByTask: { [taskId]: [] },
      pendingOptimisticIdByTask: {},
      draftAttachmentsByTask: {},
      sendingByTask: {},
      turnByTask: {},
      lastSeqByTask: { [taskId]: 0 },
      stageAnnouncement: '',
    });
  });

  it('progresses from accepted startup to the first Runtime stage without regressing', () => {
    applyEvent({
      type: 'turn.accepted',
      taskId,
      turnId: 'turn-runtime-starting',
      seq: 1,
      userMessage: {
        id: 'message-runtime-starting',
        taskId,
        turnId: 'turn-runtime-starting',
        author: 'user',
        content: 'start',
        attachments: [],
        createdAt: '2026-08-11T00:00:00.000Z',
      },
    });
    expect(useAppStore.getState().turnByTask[taskId]).toMatchObject({
      runtimeStarting: true,
      stage: 'understanding',
    });
    expect(useAppStore.getState().stageAnnouncement).toBe('Runtime起動待ち');

    applyEvent({
      type: 'stage.changed',
      taskId,
      turnId: 'turn-runtime-starting',
      seq: 2,
      stage: 'understanding',
    });
    expect(useAppStore.getState().turnByTask[taskId]).toMatchObject({
      runtimeStarting: false,
      stage: 'understanding',
    });
    expect(useAppStore.getState().stageAnnouncement).toBe('ユーザーの依頼を理解中');

    applyEvent({
      type: 'stage.changed',
      taskId,
      turnId: 'turn-runtime-starting',
      seq: 3,
      stage: 'planning',
    });
    expect(useAppStore.getState().turnByTask[taskId]).toMatchObject({
      runtimeStarting: false,
      stage: 'planning',
      reachedStageIndex: 1,
    });
  });
});
