import { randomBytes } from 'node:crypto';
import {
  computerUseNativeDiscoveryResultSchema,
  computerUseNativeDiscoveryStopReceiptSchema,
} from '@sprint-coder/contracts';
import { ComputerUseDiscoveryNotSubmittedError } from './computer-use-native-types';

export type ComputerUseDiscoveryStop =
  | Readonly<{ kind: 'not_submitted' }>
  | Readonly<{ kind: 'completed' | 'stopped'; launchAttemptCount: 0 | 1 }>;
export type ComputerUseDiscoveryHandle<T> = Readonly<{
  id: string;
  result: Promise<T>;
  /** Resolves only with validated terminal evidence, including evidence received after a failed Stop. */
  terminal: Promise<ComputerUseDiscoveryStop>;
  stop(): Promise<ComputerUseDiscoveryStop>;
}>;

type Owner = {
  id: string;
  stopped: boolean;
  cancelRequested: boolean;
  invoked: boolean;
  pending: boolean;
  unconfirmed: boolean;
  terminal: ComputerUseDiscoveryStop | null;
  stopping: Promise<ComputerUseDiscoveryStop> | null;
  terminalSignal: Promise<ComputerUseDiscoveryStop>;
  resolveTerminal: (proof: ComputerUseDiscoveryStop) => void;
  rejectCanceled: (error: Error) => void;
};

/** One trusted Main issuer. No caller supplies IDs, and a handle cannot issue another query. */
export function createComputerUseDiscoveryManager(
  options: Readonly<{
    query: (id: string, input: Readonly<Record<string, unknown>>) => Promise<unknown>;
    stop: (id: string) => Promise<unknown>;
    cancelUnsubmitted: (id: string) => 'never_sent' | 'may_have_been_sent' | 'unknown';
    timeoutMs: number;
    attemptLimit: number;
    unconfirmedError: () => Error;
  }>,
) {
  const nonce = randomBytes(16).toString('hex');
  let sequence = 0;
  const owners = new Map<string, Owner>();
  const canceledError = () => new Error('Computer Use discovery canceled');
  const trim = () => {
    for (const [id, owner] of owners) {
      if (owners.size < 128) break;
      if (owner.terminal !== null && !owner.pending) owners.delete(id);
    }
  };
  const finish = (owner: Owner, proof: ComputerUseDiscoveryStop) => {
    if (owner.terminal !== null) return owner.terminal;
    if (owners.get(owner.id) !== owner) throw options.unconfirmedError();
    owner.terminal = proof;
    owner.unconfirmed = false;
    owner.resolveTerminal(proof);
    return proof;
  };
  const completeStop = async (owner: Owner): Promise<ComputerUseDiscoveryStop> => {
    if (owner.terminal !== null) return owner.terminal;
    if (!owner.invoked || options.cancelUnsubmitted(owner.id) === 'never_sent')
      return finish(owner, { kind: 'not_submitted' });
    if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 10000)
      throw options.unconfirmedError();
    for (let attempt = 0; attempt < options.attemptLimit; attempt += 1) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          Promise.resolve()
            .then(() => options.stop(owner.id))
            .then((value) => {
              // A caller deadline does not invalidate this operation's eventual Stop proof.
              const receipt = computerUseNativeDiscoveryStopReceiptSchema.parse(value);
              if (receipt.discoveryId !== owner.id) throw options.unconfirmedError();
              return finish(owner, {
                kind: 'stopped',
                launchAttemptCount: receipt.launchAttemptCount,
              });
            }),
          owner.terminalSignal,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(options.unconfirmedError()), options.timeoutMs);
          }),
        ]);
      } catch {
        if (owner.terminal !== null) return owner.terminal;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }
    throw options.unconfirmedError();
  };
  const stop = (owner: Owner, external = true): Promise<ComputerUseDiscoveryStop> => {
    owner.stopped = true;
    if (external) owner.cancelRequested = true;
    if (owner.stopping !== null) return owner.stopping;
    if (owner.terminal !== null) {
      if (owner.cancelRequested) owner.rejectCanceled(canceledError());
      owner.stopping = Promise.resolve(owner.terminal);
      return owner.stopping;
    }
    owner.unconfirmed = true;
    let resolve!: (proof: ComputerUseDiscoveryStop) => void;
    let reject!: (error: unknown) => void;
    const stopping = new Promise<ComputerUseDiscoveryStop>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    owner.stopping = stopping;
    void completeStop(owner).then(
      (proof) => {
        if (owner.cancelRequested) owner.rejectCanceled(canceledError());
        resolve(proof);
      },
      () => {
        if (owner.stopping === stopping) owner.stopping = null;
        const error = options.unconfirmedError();
        if (owner.cancelRequested) owner.rejectCanceled(error);
        reject(error);
      },
    );
    return stopping;
  };

  const quarantined = (): boolean =>
    [...owners.values()].some(
      (owner) =>
        owner.unconfirmed ||
        (owner.stopped && owner.terminal === null) ||
        (owner.stopped && owner.terminal?.kind === 'not_submitted' && owner.pending),
    );
  return Object.freeze({
    quarantined,
    begin(
      input: Readonly<Record<string, unknown>>,
    ): ComputerUseDiscoveryHandle<readonly unknown[]> {
      if (quarantined()) throw options.unconfirmedError();
      trim();
      if (owners.size >= 128 || sequence >= Number.MAX_SAFE_INTEGER)
        throw new ComputerUseDiscoveryNotSubmittedError(
          'Native discovery lifetime capacity exceeded',
        );
      const id = nonce + ':' + ++sequence;
      let resolveTerminal!: Owner['resolveTerminal'];
      const terminalSignal = new Promise<ComputerUseDiscoveryStop>((resolve) => {
        resolveTerminal = resolve;
      });
      let rejectCanceled!: Owner['rejectCanceled'];
      const canceled = new Promise<never>((_resolve, reject) => {
        rejectCanceled = reject;
      });
      void canceled.catch(() => undefined);
      const owner: Owner = {
        id,
        stopped: false,
        cancelRequested: false,
        invoked: false,
        pending: true,
        unconfirmed: false,
        terminal: null,
        stopping: null,
        terminalSignal,
        resolveTerminal,
        rejectCanceled,
      };
      owners.set(id, owner);
      const work = Promise.resolve()
        .then(async () => {
          if (owner.stopped) throw canceledError();
          owner.invoked = true;
          const value = await options.query(id, input);
          const receipt = computerUseNativeDiscoveryResultSchema.parse(value);
          if (receipt.discoveryId !== id) throw options.unconfirmedError();
          const proof: ComputerUseDiscoveryStop =
            receipt.result === 'not_admitted'
              ? { kind: 'not_submitted' }
              : { kind: 'completed', launchAttemptCount: receipt.launchAttemptCount };
          finish(owner, proof);
          if (owner.stopped) throw canceledError();
          if (receipt.result === 'not_admitted')
            throw new Error('Native discovery capacity exceeded');
          return receipt.windows;
        })
        .catch(async (error: unknown) => {
          if (error instanceof ComputerUseDiscoveryNotSubmittedError)
            finish(owner, { kind: 'not_submitted' });
          if (owner.terminal === null) {
            try {
              await stop(owner, false);
            } catch {
              throw options.unconfirmedError();
            }
          }
          throw owner.cancelRequested ? canceledError() : error;
        })
        .finally(() => {
          owner.pending = false;
          trim();
        });
      const result = Promise.race([work, canceled]);
      // The scope may Stop before its caller attaches to the result.
      void result.catch(() => undefined);
      return Object.freeze({ id, result, terminal: terminalSignal, stop: () => stop(owner) });
    },
  });
}
