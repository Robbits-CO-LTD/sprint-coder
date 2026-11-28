import { createConnection } from 'node:net';
import { z } from 'zod';

const pairingPattern = /^blender1:([1-9][0-9]{0,4}):([A-Za-z0-9_-]{43})$/;
const responseSizeLimit = 384 * 1024;
const replySchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), result: z.unknown() }),
  z.object({ ok: z.literal(false), error: z.string().max(512) }),
]);
const targetSchema = z.string().min(1).max(1024);
const coordinatesSchema = z.tuple([z.number(), z.number(), z.number()]);
const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{32}$/);

const observationSchema = z.object({
  observation: tokenSchema,
  target: targetSchema,
  location: coordinatesSchema,
  face_count: z.number().int().nonnegative(),
  faces: z
    .array(
      z.object({
        index: z.number().int().nonnegative(),
        center: coordinatesSchema,
        normal: coordinatesSchema,
      }),
    )
    .max(64),
  face_index: z.number().int().nonnegative().nullable(),
  dataUrl: z.string().regex(/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/),
});

export const blenderObserveInputSchema = z
  .object({
    azimuth: z.number().min(-360).max(360),
    elevation: z.number().min(-89).max(89),
    faceIndex: z.number().int().nonnegative().optional(),
  })
  .strict();

export const blenderEditInputSchema = z.discriminatedUnion('operation', [
  z
    .object({
      observation: tokenSchema,
      operation: z.literal('move'),
      value: coordinatesSchema.refine((coordinates) =>
        coordinates.every((n) => Math.abs(n) <= 100),
      ),
    })
    .strict(),
  z
    .object({
      observation: tokenSchema,
      operation: z.literal('extrude'),
      value: z
        .number()
        .min(-100)
        .max(100)
        .refine((n) => n !== 0),
    })
    .strict(),
]);

type BlenderEndpoint = Readonly<{ port: number; token: string }>;

function readEndpoint(code: string): BlenderEndpoint {
  const match = pairingPattern.exec(code.trim());
  if (match === null || Number(match[1]) > 65535 || match[2] === undefined)
    throw new Error('Invalid Blender pairing code');
  return { port: Number(match[1]), token: match[2] };
}

async function blenderRequest(
  endpoint: BlenderEndpoint,
  request: Readonly<Record<string, unknown>>,
  signal: AbortSignal,
): Promise<unknown> {
  signal.throwIfAborted();
  const frame = JSON.stringify({ ...request, token: endpoint.token }) + '\n';
  return await new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port: endpoint.port, signal });
    const chunks: Buffer[] = [];
    let length = 0;
    const timeout = setTimeout(
      () => socket.destroy(new Error('Blender request timed out')),
      11_000,
    );
    socket.once('connect', () => socket.write(frame));
    socket.once('error', reject);
    socket.once('close', () => {
      clearTimeout(timeout);
      reject(new Error('Blender disconnected'));
    });
    socket.on('data', (chunk: Buffer) => {
      length += chunk.length;
      if (length > responseSizeLimit) {
        socket.destroy(new Error('Blender response was too large'));
        return;
      }
      chunks.push(chunk);
      if (chunk[chunk.length - 1] !== 10) return;
      try {
        const reply = replySchema.parse(JSON.parse(Buffer.concat(chunks, length).toString('utf8')));
        if (reply.ok) resolve(reply.result);
        else reject(new Error(reply.error));
      } catch {
        reject(new Error('Invalid Blender response'));
      } finally {
        socket.destroy();
      }
    });
  });
}

export class BlenderTeamConnection {
  private readonly lifetime = new AbortController();
  private readonly slots = new Map<string, number>();
  private readonly busy = new Set<string>();
  private readonly observations = new Map<string, { token: string; turn: AbortSignal }>();

  get active(): boolean {
    return !this.lifetime.signal.aborted;
  }

  private constructor(
    private readonly endpoint: BlenderEndpoint,
    readonly targets: readonly string[],
  ) {}

  static async pair(code: string, signal: AbortSignal): Promise<BlenderTeamConnection> {
    const endpoint = readEndpoint(code);
    const result = z
      .object({
        token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
        targets: z.array(targetSchema).min(1).max(10),
      })
      .parse(await blenderRequest(endpoint, { method: 'pair' }, signal));
    return new BlenderTeamConnection({ port: endpoint.port, token: result.token }, result.targets);
  }

  close(): void {
    if (this.lifetime.signal.aborted) return;
    this.lifetime.abort();
    this.observations.clear();
    void blenderRequest(this.endpoint, { method: 'disconnect' }, AbortSignal.timeout(2_000)).catch(
      () => undefined,
    );
  }

  async isAvailable(): Promise<boolean> {
    try {
      return (
        (await blenderRequest(
          this.endpoint,
          { method: 'status' },
          AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(2_000)]),
        )) === true
      );
    } catch {
      return false;
    }
  }

  async call(
    worker: string,
    tool: 'blender_observe' | 'blender_edit',
    input: unknown,
    callerSignal: AbortSignal,
  ) {
    const signal = AbortSignal.any([callerSignal, this.lifetime.signal]);
    signal.throwIfAborted();
    if (this.busy.has(worker))
      throw new Error('This Worker already has a pending Blender operation');
    this.busy.add(worker);
    try {
      if (tool === 'blender_observe') {
        const args = blenderObserveInputSchema.parse(input);
        let slot = this.slots.get(worker);
        if (slot === undefined) {
          slot = this.slots.size;
          if (slot >= this.targets.length)
            throw new Error('All paired Blender targets have a Worker');
          this.slots.set(worker, slot);
        }
        await blenderRequest(this.endpoint, { method: 'bind', worker, slot }, signal);
        this.observations.delete(worker);
        const observation = observationSchema.parse(
          await blenderRequest(this.endpoint, { method: 'observe', worker, ...args }, signal),
        );
        signal.throwIfAborted();
        this.observations.set(worker, { token: observation.observation, turn: callerSignal });
        return observation;
      }
      if (!this.slots.has(worker))
        throw new Error('Observe the assigned Blender target before editing');
      const args = blenderEditInputSchema.parse(input);
      const observation = this.observations.get(worker);
      if (observation?.turn !== callerSignal || observation.token !== args.observation)
        throw new Error('Observation expired or belongs to a different Worker or Turn');
      this.observations.delete(worker);
      return z
        .object({ target: targetSchema, revision: z.number().int().positive() })
        .parse(await blenderRequest(this.endpoint, { method: 'edit', worker, ...args }, signal));
    } finally {
      this.busy.delete(worker);
    }
  }
}
