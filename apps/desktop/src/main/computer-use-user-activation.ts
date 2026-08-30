import { randomUUID } from 'node:crypto';
import type { IpcMainEvent, IpcMainInvokeEvent, WebContents } from 'electron';

export const COMPUTER_USE_ACTIVATION_TTL_MS = 2_000;

export type ComputerUseActivationPermit = Readonly<{
  token: string;
  serial: number;
  generation: number;
  senderId: number;
  frameProcessId: number;
  frameRoutingId: number;
  windowId: number;
  inputKind: 'mouse' | 'keyboard';
  pickerKind: 'application' | 'window' | 'start' | 'approval';
  intent: string | null;
  issuedAtMs: number;
}>;

type RecordedActivation = Omit<ComputerUseActivationPermit, 'token' | 'pickerKind'> &
  Readonly<{ pickerKind: ComputerUseActivationPermit['pickerKind'] | null }>;

/**
 * Records activation in Main before the renderer receives it.  A renderer script cannot mint or
 * replay the resulting permit: consume() returns it only to Main and clears the record first.
 */
export class ComputerUseUserActivationGate {
  private serial = 0;
  private generationValue = 0;
  private latest: RecordedActivation | null = null;
  private readonly disposers: Array<() => void> = [];

  constructor(
    private readonly contents: WebContents,
    private readonly windowId: number,
    private readonly now: () => number = Date.now,
  ) {
    const beforeMouse = (_event: Electron.Event, input: Electron.MouseInputEvent): void => {
      if (input.type === 'mouseDown' && input.button === 'left') this.record('mouse');
    };
    const beforeKeyboard = (_event: Electron.Event, input: Electron.Input): void => {
      if (
        input.type === 'keyDown' &&
        !input.isAutoRepeat &&
        !input.isComposing &&
        (input.key === 'Enter' || input.key === ' ')
      )
        this.record('keyboard');
    };
    const invalidate = (): void => this.invalidate();
    contents.on('before-mouse-event', beforeMouse);
    contents.on('before-input-event', beforeKeyboard);
    contents.on('did-start-navigation', invalidate);
    contents.on('render-process-gone', invalidate);
    contents.on('destroyed', invalidate);
    this.disposers.push(
      () => contents.removeListener('before-mouse-event', beforeMouse),
      () => contents.removeListener('before-input-event', beforeKeyboard),
      () => contents.removeListener('did-start-navigation', invalidate),
      () => contents.removeListener('render-process-gone', invalidate),
      () => contents.removeListener('destroyed', invalidate),
    );
  }

  consume(
    event: IpcMainInvokeEvent,
    pickerKind: ComputerUseActivationPermit['pickerKind'],
  ): ComputerUseActivationPermit | null {
    const recorded = this.latest;
    this.latest = null;
    if (
      recorded === null ||
      this.now() - recorded.issuedAtMs > COMPUTER_USE_ACTIVATION_TTL_MS ||
      event.sender !== this.contents ||
      event.sender.id !== recorded.senderId ||
      event.senderFrame !== this.contents.mainFrame ||
      event.senderFrame.processId !== recorded.frameProcessId ||
      event.senderFrame.routingId !== recorded.frameRoutingId ||
      recorded.pickerKind !== pickerKind
    )
      return null;
    return Object.freeze({ ...recorded, token: randomUUID(), pickerKind });
  }

  /**
   * Binds the latest Main-observed input to the exact trusted preload control that received it.
   * The binding message is useful only after a matching native input serial already exists; it
   * cannot mint an activation and cannot change an activation after it has been bound.
   */
  bindIntent(
    event: IpcMainEvent,
    pickerKind: ComputerUseActivationPermit['pickerKind'],
    intent: string | null = null,
  ): boolean {
    const recorded = this.latest;
    if (
      recorded === null ||
      recorded.pickerKind !== null ||
      this.now() - recorded.issuedAtMs > COMPUTER_USE_ACTIVATION_TTL_MS ||
      event.sender !== this.contents ||
      event.sender.id !== recorded.senderId ||
      event.senderFrame !== this.contents.mainFrame ||
      event.senderFrame.processId !== recorded.frameProcessId ||
      event.senderFrame.routingId !== recorded.frameRoutingId
    )
      return false;
    if (intent !== null && (intent.length < 1 || intent.length > 2_048)) return false;
    this.latest = Object.freeze({ ...recorded, pickerKind, intent });
    return true;
  }

  invalidate(): void {
    this.latest = null;
    this.generationValue += 1;
  }

  /** Monotonic epoch used by Main-owned latches to detect same-frame navigation. */
  generation(): number {
    return this.generationValue;
  }

  dispose(): void {
    this.invalidate();
    for (const dispose of this.disposers.splice(0)) dispose();
  }

  /** Test-only seam; production records exclusively through WebContents events above. */
  recordForTest(inputKind: RecordedActivation['inputKind']): void {
    if (process.env['NODE_ENV'] !== 'test') throw new Error('Activation test seam is unavailable');
    this.record(inputKind);
  }

  private record(inputKind: RecordedActivation['inputKind']): void {
    const frame = this.contents.mainFrame;
    this.serial += 1;
    // A newer Main-observed gesture must revoke deferred Quick Start latches, even when the
    // renderer is still waiting for an earlier window enumeration to finish.
    this.generationValue += 1;
    this.latest = Object.freeze({
      serial: this.serial,
      generation: this.generationValue,
      senderId: this.contents.id,
      frameProcessId: frame.processId,
      frameRoutingId: frame.routingId,
      windowId: this.windowId,
      inputKind,
      pickerKind: null,
      intent: null,
      issuedAtMs: this.now(),
    });
  }
}
