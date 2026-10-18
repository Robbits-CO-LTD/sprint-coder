import { describe, expect, it } from 'vitest';
import { TeamIntegrationScheduler } from './team-integration-scheduler';

const repoKeys = async () => ['repo'];

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

describe('TeamIntegrationScheduler reads beside integrations (issue #864)', () => {
  function heldIntegrations(scheduler: TeamIntegrationScheduler, ids: readonly string[]) {
    const running: string[] = [];
    const releases = new Map<string, () => void>();
    const done = ids.map((executionId) =>
      scheduler.submit({
        executionId,
        mutationKeys: ['repo'],
        async run() {
          running.push(executionId);
          await new Promise<void>((resolve) => releases.set(executionId, resolve));
        },
      }),
    );
    return { running, releases, done };
  }

  it('runs an exclusive read after the running integration and ahead of the queued ones', async () => {
    const scheduler = new TeamIntegrationScheduler();
    const { running, releases, done } = heldIntegrations(scheduler, ['a', 'b', 'c']);
    await flush();
    const observed: string[][] = [];
    const read = scheduler.runExclusive(['repo'], async () => {
      observed.push([...running]);
      return 'clean';
    });
    await flush();
    expect(observed).toEqual([]);
    expect(scheduler.snapshot().queuedExecutionIds[0]).toMatch(/^exclusive:/u);
    releases.get('a')!();
    await expect(read).resolves.toBe('clean');
    expect(observed).toEqual([['a']]);
    await flush();
    expect(running).toEqual(['a', 'b']);
    releases.get('b')!();
    await flush();
    releases.get('c')!();
    await Promise.all(done);
  });

  it('keeps a read that succeeds beside a running integration without waiting', async () => {
    const scheduler = new TeamIntegrationScheduler();
    const { releases, done } = heldIntegrations(scheduler, ['a', 'b']);
    await flush();
    await expect(scheduler.readBesideIntegrations(repoKeys, async () => 'clean')).resolves.toBe(
      'clean',
    );
    expect(scheduler.snapshot().queuedExecutionIds).toEqual(['b']);
    releases.get('a')!();
    await flush();
    releases.get('b')!();
    await Promise.all(done);
  });

  it('fails a read that fails with no integration beside it, without reading again', async () => {
    const scheduler = new TeamIntegrationScheduler();
    let reads = 0;
    await expect(
      scheduler.readBesideIntegrations(repoKeys, async () => {
        reads += 1;
        throw new Error('dirty');
      }),
    ).rejects.toThrow('dirty');
    expect(reads).toBe(1);
  });

  it('reads again after the running integration only when a failed read overlapped one', async () => {
    const scheduler = new TeamIntegrationScheduler();
    const { running, releases, done } = heldIntegrations(scheduler, ['a', 'b']);
    await flush();
    const reads: string[][] = [];
    const read = scheduler.readBesideIntegrations(repoKeys, async () => {
      reads.push([...running]);
      if (reads.length === 1) throw new Error('cherry-pick in progress');
      return 'clean';
    });
    await flush();
    expect(reads).toEqual([['a']]);
    releases.get('a')!();
    await expect(read).resolves.toBe('clean');
    expect(reads).toEqual([['a'], ['a']]);
    await flush();
    expect(running).toEqual(['a', 'b']);
    releases.get('b')!();
    await Promise.all(done);
  });

  it('fails a read that still fails when read again after the overlapping integration', async () => {
    const scheduler = new TeamIntegrationScheduler();
    const { running, releases, done } = heldIntegrations(scheduler, ['a']);
    await flush();
    const reads: string[][] = [];
    const read = scheduler.readBesideIntegrations(repoKeys, async () => {
      reads.push([...running]);
      throw new Error('user edit');
    });
    read.catch(() => undefined);
    await flush();
    expect(reads).toHaveLength(1);
    releases.get('a')!();
    await expect(read).rejects.toThrow('user edit');
    expect(reads).toHaveLength(2);
    await Promise.all(done);
  });

  it('reads again when an integration started and finished during a failed read', async () => {
    const scheduler = new TeamIntegrationScheduler();
    let reads = 0;
    const read = scheduler.readBesideIntegrations(repoKeys, async () => {
      reads += 1;
      if (reads > 1) return 'clean';
      await scheduler.submit({ executionId: 'a', mutationKeys: ['repo'], async run() {} });
      throw new Error('cherry-pick in progress');
    });
    await expect(read).resolves.toBe('clean');
    expect(reads).toBe(2);
  });
});

describe('TeamIntegrationScheduler resolves keys only to read again (issue #864)', () => {
  it('resolves no keys for a read that succeeds or fails alone', async () => {
    const scheduler = new TeamIntegrationScheduler();
    let resolved = 0;
    const keys = async () => {
      resolved += 1;
      return ['repo'];
    };
    await expect(scheduler.readBesideIntegrations(keys, async () => 'clean')).resolves.toBe(
      'clean',
    );
    await expect(
      scheduler.readBesideIntegrations(keys, async () => {
        throw new Error('dirty');
      }),
    ).rejects.toThrow('dirty');
    expect(resolved).toBe(0);
  });

  it('fails as it is when an overlapped read has no keys to read again on', async () => {
    const scheduler = new TeamIntegrationScheduler();
    let reads = 0;
    const read = scheduler.readBesideIntegrations(
      async () => [],
      async () => {
        reads += 1;
        await scheduler.submit({ executionId: 'a', mutationKeys: ['repo'], async run() {} });
        throw new Error('not a repository');
      },
    );
    await expect(read).rejects.toThrow('not a repository');
    expect(reads).toBe(1);
  });
});
