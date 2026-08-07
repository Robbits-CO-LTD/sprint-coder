import type { TeamEvent, TeamSubscriptionSnapshot } from '@sprint-coder/contracts';

export function createTeamSubscriptionBuffer(listener: (event: TeamEvent) => void) {
  let pending = true;
  let disposed = false;
  const buffered: TeamEvent[] = [];

  return {
    push(event: TeamEvent): void {
      if (disposed) return;
      if (pending) buffered.push(event);
      else listener(event);
    },
    activate(snapshot: TeamSubscriptionSnapshot): void {
      if (disposed || !pending) return;
      listener(snapshot);
      let lastSequence = snapshot.seq;
      for (const event of buffered) {
        if (event.type !== 'updated' || event.seq <= lastSequence) continue;
        listener(event);
        lastSequence = event.seq;
      }
      buffered.length = 0;
      pending = false;
    },
    dispose(): void {
      disposed = true;
      buffered.length = 0;
    },
  };
}
