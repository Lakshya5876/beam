import { describe, expect, it } from 'vitest';
import { submitPin } from '../src/bootstrap.js';

/** Minimal WebSocket stand-in exposing just what submitPin touches. */
class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  public sent: string[] = [];
  public throwOnSend = false;
  private listeners: Array<() => void> = [];

  constructor(public readyState: number) {}

  send(message: string): void {
    if (this.throwOnSend) {
      const error = new Error("Failed to execute 'send' on 'WebSocket': Still in CONNECTING state.");
      error.name = 'InvalidStateError';
      throw error;
    }
    this.sent.push(message);
  }

  addEventListener(_type: 'open', handler: () => void): void {
    this.listeners.push(handler);
  }

  open(): void {
    this.readyState = FakeSocket.OPEN;
    for (const handler of this.listeners.splice(0)) handler();
  }
}

function asWebSocket(fake: FakeSocket): WebSocket {
  return fake as unknown as WebSocket;
}

describe('submitPin', () => {
  it('sends immediately when the socket is open', () => {
    const socket = new FakeSocket(FakeSocket.OPEN);

    expect(submitPin(asWebSocket(socket), '123456')).toBe(true);
    expect(socket.sent).toEqual([JSON.stringify({ type: 'pin', value: '123456' })]);
  });

  it('defers the send until open instead of throwing while CONNECTING', () => {
    // The PIN form renders before the signaling socket finishes connecting;
    // submitting in that window used to throw InvalidStateError.
    const socket = new FakeSocket(FakeSocket.CONNECTING);

    const accepted = submitPin(asWebSocket(socket), '123456');

    expect(accepted).toBe(true);
    expect(socket.sent).toEqual([]);
    socket.open();
    expect(socket.sent).toEqual([JSON.stringify({ type: 'pin', value: '123456' })]);
  });

  it('sends the queued PIN exactly once on open', () => {
    const socket = new FakeSocket(FakeSocket.CONNECTING);
    submitPin(asWebSocket(socket), '123456');

    socket.open();
    socket.open();

    expect(socket.sent).toHaveLength(1);
  });

  it('reports failure on a closed socket so the form stays retryable', () => {
    for (const state of [FakeSocket.CLOSING, FakeSocket.CLOSED]) {
      const socket = new FakeSocket(state);
      expect(submitPin(asWebSocket(socket), '123456')).toBe(false);
      expect(socket.sent).toEqual([]);
    }
  });

  it('reports failure — never latches — when an open socket throws', () => {
    // A latched guard with nothing sent left the user stuck on the PIN screen
    // with no way to retry; the caller must be told the send did not happen.
    const socket = new FakeSocket(FakeSocket.OPEN);
    socket.throwOnSend = true;

    expect(submitPin(asWebSocket(socket), '123456')).toBe(false);
  });

  it('swallows a throw from the deferred send rather than escaping as unhandled', () => {
    const socket = new FakeSocket(FakeSocket.CONNECTING);
    submitPin(asWebSocket(socket), '123456');
    socket.throwOnSend = true;

    expect(() => { socket.open(); }).not.toThrow();
  });
});
