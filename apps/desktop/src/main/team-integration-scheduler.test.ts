import { describe, expect, it } from 'vitest';
import { TeamIntegrationScheduler } from './team-integration-scheduler';

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('TeamIntegrationScheduler', () => {
  it('runs overlapping mutation keys in FIFO order', async () => {
    const scheduler = new TeamIntegrationScheduler();
    const started: string[] = [];
    const releases: Array<() => void> = [];
    const submit = (executionId: string) =>
      scheduler.submit({
        executionId,
        mutationKeys: ['same-root'],
        async run() {
          started.push(executionId);
          await new Promise<void>((resolve) => releases.push(resolve));
        },
      });

    const first = submit('first');
    const second = submit('second');
    const third = submit('third');
    await flush();
    expect(started).toEqual(['first']);
    releases.shift()?.();
    await first;
    await flush();
    expect(started).toEqual(['first', 'second']);
    releases.shift()?.();
    await second;
    await flush();
    expect(started).toEqual(['first', 'second', 'third']);
    releases.shift()?.();
    await third;
  });

  it('runs disjoint mutation keys without waiting for each other', async () => {
    const scheduler = new TeamIntegrationScheduler();
    const started: string[] = [];
    const releases: Array<() => void> = [];
    const jobs = ['repo-a', 'repo-b'].map((key) =>
      scheduler.submit({
        executionId: key,
        mutationKeys: [key],
        async run() {
          started.push(key);
          await new Promise<void>((resolve) => releases.push(resolve));
        },
      }),
    );

    await flush();
    expect(new Set(started)).toEqual(new Set(['repo-a', 'repo-b']));
    releases.splice(0).forEach((release) => release());
    await Promise.all(jobs);
  });

  it('rejects duplicate execution ids and releases keys after failure', async () => {
    const scheduler = new TeamIntegrationScheduler();
    const first = scheduler.submit({
      executionId: 'same',
      mutationKeys: ['root'],
      async run() {
        throw new Error('integration failed');
      },
    });
    await expect(
      scheduler.submit({ executionId: 'same', mutationKeys: ['root'], async run() {} }),
    ).rejects.toThrow('already scheduled');
    await expect(first).rejects.toThrow('integration failed');
    await expect(
      scheduler.submit({ executionId: 'next', mutationKeys: ['root'], async run() {} }),
    ).resolves.toBeUndefined();
  });
});

describe('TeamIntegrationScheduler.runExclusive', () => {
  it('waits for an integration on the same key and returns its result (issue #853)', async () => {
    const scheduler = new TeamIntegrationScheduler();
    let releaseIntegration!: () => void;
    let integrating = false;
    const integration = scheduler.submit({
      executionId: 'integration',
      mutationKeys: ['repo'],
      async run() {
        integrating = true;
        await new Promise<void>((resolve) => {
          releaseIntegration = resolve;
        });
        integrating = false;
      },
    });
    await flush();
    const observed: boolean[] = [];
    const check = scheduler.runExclusive(['repo'], async () => {
      observed.push(integrating);
      return 'clean';
    });
    const other = scheduler.runExclusive(['other-repo'], async () => 'other');
    await expect(other).resolves.toBe('other');
    await flush();
    expect(observed).toEqual([]);
    releaseIntegration();
    await integration;
    await expect(check).resolves.toBe('clean');
    expect(observed).toEqual([false]);
  });

  it('passes on the error of the exclusive run', async () => {
    const scheduler = new TeamIntegrationScheduler();
    await expect(
      scheduler.runExclusive(['repo'], async () => {
        throw new Error('dirty');
      }),
    ).rejects.toThrow('dirty');
  });
});
