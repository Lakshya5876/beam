import { describe, it, expect } from 'vitest';
import { SessionDurableObject, VIEWER_VERIFY_TIMEOUT_MS, type SessionPolicyEnv } from '../src/session-do.js';
import { hashPin, PIN_HASH_KEY, PIN_ATTEMPTS_KEY } from '../src/pin-store.js';

/**
 * Hand-rolled fakes of the Workers-only DurableObjectState/WebSocket
 * globals. Before this file, session-do.ts — the DO that owns role
 * assignment, the PIN gate, the opaque relay, and the eviction alarm — had
 * ZERO dedicated regression coverage (SECURITY_AUDIT_20-08.md finding #7):
 * its own doc comment called it "verified live", and vitest.config.ts's
 * coverage gate explicitly excludes it as "not unit-testable in Node". That
 * was true only in the sense that `new WebSocketPair()` (used inside
 * acceptPeer(), for a real HTTP Upgrade response) has no Node equivalent —
 * every OTHER entry point (webSocketMessage, webSocketClose, webSocketError,
 * alarm) takes plain values and a WebSocket-shaped object, and is fully
 * exercisable against a fake that implements just the subset of those two
 * interfaces the DO actually calls. See tsconfig.do-test.json for why this
 * one file needs Workers-style typing instead of the Node typing every
 * other signaling test uses.
 */

class FakeSocket {
  readonly sent: Array<string | ArrayBuffer> = [];
  closed: { code: number; reason: string } | null = null;

  send(message: string | ArrayBuffer): void {
    if (this.closed) throw new Error('FakeSocket: send after close');
    this.sent.push(message);
  }

  close(code = 1000, reason = ''): void {
    if (this.closed) return; // a real WebSocket.close() on an already-closed socket is a no-op
    this.closed = { code, reason };
  }
}

/**
 * Every op yields at least one real microtask tick, the same shape of gap a
 * genuine DO storage call has — this is what makes the PIN-attempt race
 * test (finding #5) meaningful: without pinVerifyQueue serializing
 * doHandlePinVerify, two attempts issued back-to-back interleave at exactly
 * these yields, each reading the SAME stale attempts count.
 */
class FakeStorage {
  private readonly data = new Map<string, unknown>();
  private alarmAt: number | null = null;

  async get<T>(key: string): Promise<T | undefined> {
    await Promise.resolve();
    return this.data.get(key) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    await Promise.resolve();
    this.data.set(key, value);
  }

  delete(keyOrKeys: string | string[]): Promise<boolean> | Promise<number> {
    return Promise.resolve().then(() => {
      if (Array.isArray(keyOrKeys)) {
        let count = 0;
        for (const key of keyOrKeys) {
          if (this.data.delete(key)) count += 1;
        }
        return count;
      }
      return this.data.delete(keyOrKeys);
    }) as Promise<boolean> & Promise<number>;
  }

  async list<T>(options?: { prefix?: string }): Promise<Map<string, T>> {
    await Promise.resolve();
    const prefix = options?.prefix ?? '';
    const out = new Map<string, T>();
    for (const [key, value] of this.data) {
      if (key.startsWith(prefix)) out.set(key, value as T);
    }
    return out;
  }

  async setAlarm(scheduledTime: number | Date): Promise<void> {
    this.alarmAt = scheduledTime instanceof Date ? scheduledTime.getTime() : scheduledTime;
  }

  async deleteAlarm(): Promise<void> {
    this.alarmAt = null;
  }

  hasAlarm(): boolean {
    return this.alarmAt !== null;
  }

  has(key: string): boolean {
    return this.data.has(key);
  }
}

const CODE = 'testsessioncodeaaaaaaaaaaa';

class FakeDurableObjectState {
  readonly storage = new FakeStorage();
  readonly id = { name: CODE, toString: () => CODE, equals: () => false };

  private readonly tagsByWs = new Map<FakeSocket, string[]>();

  accept(ws: FakeSocket, tags: string[] = []): void {
    this.tagsByWs.set(ws, tags);
  }

  acceptWebSocket(ws: unknown, tags: string[] = []): void {
    this.accept(ws as FakeSocket, tags);
  }

  getWebSockets(tag?: string): FakeSocket[] {
    const out: FakeSocket[] = [];
    for (const [ws, tags] of this.tagsByWs) {
      if (ws.closed) continue; // the hibernation API only ever returns live sockets
      if (tag === undefined || tags.includes(tag)) out.push(ws);
    }
    return out;
  }

  getTags(ws: unknown): string[] {
    return this.tagsByWs.get(ws as FakeSocket) ?? [];
  }
}

function makeDo(env: SessionPolicyEnv = {}): { obj: SessionDurableObject; state: FakeDurableObjectState } {
  const state = new FakeDurableObjectState();
  const obj = new SessionDurableObject(state as unknown as ConstructorParameters<typeof SessionDurableObject>[0], env);
  return { obj, state };
}

function control(obj: Record<string, unknown>): string {
  return JSON.stringify(obj);
}

function asWs(s: FakeSocket): Parameters<SessionDurableObject['webSocketMessage']>[0] {
  return s as unknown as Parameters<SessionDurableObject['webSocketMessage']>[0];
}

async function pinRegister(obj: SessionDurableObject, host: FakeSocket, pin: string): Promise<void> {
  const hash = await hashPin(pin, CODE);
  await obj.webSocketMessage(asWs(host), control({ type: 'pin-register', hash }));
}

function connectHost(state: FakeDurableObjectState): FakeSocket {
  const ws = new FakeSocket();
  state.accept(ws, ['host']);
  return ws;
}

function connectViewer(state: FakeDurableObjectState): FakeSocket {
  const ws = new FakeSocket();
  state.accept(ws, ['viewer']);
  return ws;
}

describe('SessionDurableObject — PIN pairing and opaque relay', () => {
  it('relays a host offer to the viewer only after the correct PIN verifies', async () => {
    const { obj, state } = makeDo();
    const host = connectHost(state);
    const viewer = connectViewer(state);

    await pinRegister(obj, host, '123456');
    await obj.webSocketMessage(asWs(host), control({ kind: 'offer', payload: 'sdp-offer' }));
    // Pre-verification: buffered, not yet delivered.
    expect(viewer.sent).toHaveLength(0);

    await obj.webSocketMessage(asWs(viewer), control({ type: 'pin', value: '123456' }));

    expect(viewer.sent).toContain(control({ type: 'pin-ok' }));
    expect(viewer.sent).toContain(control({ kind: 'offer', payload: 'sdp-offer' }));
  });

  it('never relays a viewer message before PIN verification, even to a listening host', async () => {
    const { obj, state } = makeDo();
    const host = connectHost(state);
    const viewer = connectViewer(state);
    await pinRegister(obj, host, '123456');

    await obj.webSocketMessage(asWs(viewer), control({ kind: 'ice-candidate', payload: 'evil' }));

    expect(host.sent).toHaveLength(0);
  });

  it('locks the session after 3 wrong attempts and closes with 1008', async () => {
    const { obj, state } = makeDo();
    const host = connectHost(state);
    const viewer = connectViewer(state);
    await pinRegister(obj, host, '123456');

    for (let i = 0; i < 3; i += 1) {
      await obj.webSocketMessage(asWs(viewer), control({ type: 'pin', value: '000000' }));
    }

    expect(viewer.closed).toEqual({ code: 1008, reason: 'pin-locked' });
  });

  it('the DO alarm evicts an unverified viewer, freeing the slot', async () => {
    const { obj, state } = makeDo();
    connectHost(state);
    const viewer = connectViewer(state);
    void VIEWER_VERIFY_TIMEOUT_MS; // documents the real timer this alarm stands in for
    await obj.alarm();
    expect(viewer.closed).toEqual({ code: 4001, reason: 'verification-timeout' });
  });

  it('the alarm is a no-op once the viewer already verified', async () => {
    const { obj, state } = makeDo();
    const host = connectHost(state);
    const viewer = connectViewer(state);
    await pinRegister(obj, host, '123456');
    await obj.webSocketMessage(asWs(viewer), control({ type: 'pin', value: '123456' }));

    await obj.alarm();

    expect(viewer.closed).toBeNull();
  });
});

describe('SessionDurableObject — host-role hijack after disconnect (SECURITY_AUDIT_20-08.md finding #2, High)', () => {
  it('clears PIN-verified state and closes the viewer the instant the host disconnects', async () => {
    const { obj, state } = makeDo();
    const host = connectHost(state);
    const viewer = connectViewer(state);
    await pinRegister(obj, host, '123456');
    await obj.webSocketMessage(asWs(viewer), control({ type: 'pin', value: '123456' }));
    expect(state.storage.has('pin-verified')).toBe(true);

    await obj.webSocketClose(asWs(host));

    expect(state.storage.has('pin-verified')).toBe(false);
    expect(viewer.closed).toEqual({ code: 4002, reason: 'peer-disconnected' });
  });

  it('a reconnecting attacker who claims the vacated host slot cannot get anything relayed to the real, already-verified viewer', async () => {
    const { obj, state } = makeDo();
    const host = connectHost(state);
    const viewer = connectViewer(state);
    await pinRegister(obj, host, '123456');
    await obj.webSocketMessage(asWs(viewer), control({ type: 'pin', value: '123456' }));

    // Host's connection drops (network blip, laptop sleep — not necessarily
    // an attack in itself).
    await obj.webSocketClose(asWs(host));

    // An attacker who only ever knew the session code (never the PIN) races
    // in and claims the now-vacant 'host' slot.
    const attacker = new FakeSocket();
    state.accept(attacker, ['host']);

    // Pre-fix, PIN_VERIFIED_KEY was still true here, so this would have been
    // relayed straight to the (already-closed, but in the live-bug scenario
    // still-open) viewer with no PIN check at all.
    await obj.webSocketMessage(asWs(attacker), control({ kind: 'offer', payload: 'attacker-controlled-sdp' }));

    expect(viewer.sent.some((m) => String(m).includes('attacker-controlled-sdp'))).toBe(false);
  });

  it('the attacker cannot forge a working pairing either: their own chosen PIN never matches what the real viewer submits', async () => {
    const { obj, state } = makeDo();
    const host = connectHost(state);
    await pinRegister(obj, host, '123456');
    await obj.webSocketClose(asWs(host)); // host gone before a viewer ever verified

    // Attacker claims 'host' and registers a hash for a PIN of THEIR choosing.
    const attacker = new FakeSocket();
    state.accept(attacker, ['host']);
    await pinRegister(obj, attacker, '999999');

    // The real user, holding the real link + the REAL PIN told to them
    // out-of-band, connects as viewer and types the real PIN.
    const realViewer = new FakeSocket();
    state.accept(realViewer, ['viewer']);
    await obj.webSocketMessage(asWs(realViewer), control({ type: 'pin', value: '123456' }));

    // Wrong (relative to the attacker's registered hash) — rejected, not
    // silently accepted, and nothing is ever relayed.
    expect(realViewer.sent.some((m) => String(m).includes('pin-ok'))).toBe(false);
    expect(realViewer.sent.some((m) => String(m).includes('pin-failed'))).toBe(true);
  });

  it('viewer disconnect is handled symmetrically: PIN state resets and the host is closed too', async () => {
    const { obj, state } = makeDo();
    const host = connectHost(state);
    const viewer = connectViewer(state);
    await pinRegister(obj, host, '123456');
    await obj.webSocketMessage(asWs(viewer), control({ type: 'pin', value: '123456' }));

    await obj.webSocketClose(asWs(viewer));

    expect(state.storage.has('pin-verified')).toBe(false);
    expect(host.closed).toEqual({ code: 4002, reason: 'peer-disconnected' });
  });

  it('webSocketError drives the same teardown as webSocketClose', async () => {
    const { obj, state } = makeDo();
    const host = connectHost(state);
    const viewer = connectViewer(state);
    await pinRegister(obj, host, '123456');
    await obj.webSocketMessage(asWs(viewer), control({ type: 'pin', value: '123456' }));

    await obj.webSocketError(asWs(host));

    expect(state.storage.has('pin-verified')).toBe(false);
    expect(viewer.closed).toEqual({ code: 4002, reason: 'peer-disconnected' });
  });

  it('is safe to call for a socket that was never assigned a role', async () => {
    const { obj } = makeDo();
    const stray = new FakeSocket();
    await expect(obj.webSocketClose(asWs(stray))).resolves.toBeUndefined();
  });

  it('an UNVERIFIED viewer disconnecting must not disturb the host or the still-valid PIN hash — T1b\'s squatter-eviction-then-retry recovery path (adversarial re-pass finding: an earlier version of this fix broke it)', async () => {
    const { obj, state } = makeDo();
    const host = connectHost(state);
    const squatter = connectViewer(state); // never submits a PIN
    await pinRegister(obj, host, '123456');

    await obj.webSocketClose(asWs(squatter));

    // The host must still be open, and the hash must still be exactly what
    // it was — the very next connectViewer() must be able to verify against
    // the SAME PIN without the host doing anything.
    expect(host.closed).toBeNull();
    expect(await state.storage.get(PIN_HASH_KEY)).toBeDefined();

    const realViewer = new FakeSocket();
    state.accept(realViewer, ['viewer']);
    await obj.webSocketMessage(asWs(realViewer), control({ type: 'pin', value: '123456' }));
    expect(realViewer.sent).toContain(control({ type: 'pin-ok' }));
  });

  it('reproduces the real Cloudflare runtime\'s behavior end-to-end: the alarm evicting an unverified viewer routes back through webSocketClose, and the host survives it', async () => {
    // Cloudflare's hibernation API invokes webSocketClose for a socket this
    // SAME Durable Object closes via ws.close() — not only for closes
    // initiated by the remote end. alarm() calling ws.close() on a
    // squatting viewer therefore fires onPeerGone for that viewer exactly
    // as a remote disconnect would; this test drives that full sequence
    // rather than only the alarm's own direct effect (already covered
    // above), since that's the sequence that actually broke in the
    // adversarial re-pass.
    const { obj, state } = makeDo();
    const host = connectHost(state);
    const squatter = connectViewer(state);
    await pinRegister(obj, host, '123456');

    await obj.alarm(); // evicts the squatter: ws.close(4001, 'verification-timeout')
    await obj.webSocketClose(asWs(squatter)); // the real runtime's follow-up callback

    expect(host.closed).toBeNull();
    expect(await state.storage.get(PIN_HASH_KEY)).toBeDefined();

    const realViewer = new FakeSocket();
    state.accept(realViewer, ['viewer']);
    await obj.webSocketMessage(asWs(realViewer), control({ type: 'pin', value: '123456' }));
    expect(realViewer.sent).toContain(control({ type: 'pin-ok' }));
  });

  it('a VERIFIED viewer disconnecting IS the mirror hijack case: PIN_VERIFIED_KEY resets and the host closes, but PIN_HASH_KEY is untouched (the host itself was never compromised)', async () => {
    const { obj, state } = makeDo();
    const host = connectHost(state);
    const viewer = connectViewer(state);
    await pinRegister(obj, host, '123456');
    await obj.webSocketMessage(asWs(viewer), control({ type: 'pin', value: '123456' }));
    expect(await state.storage.get('pin-verified')).toBe(true);

    await obj.webSocketClose(asWs(viewer));

    expect(host.closed).toEqual({ code: 4002, reason: 'peer-disconnected' });
    expect(await state.storage.get('pin-verified')).toBeUndefined();
    expect(await state.storage.get(PIN_HASH_KEY)).toBeDefined(); // host's own hash survives — the host wasn't the one that left
  });

  it('disconnect also discards any host offer/ICE buffered pre-verification, so it can never be replayed to a future, unrelated pairing', async () => {
    const { obj, state } = makeDo();
    const host = connectHost(state);
    connectViewer(state);
    await pinRegister(obj, host, '123456');
    // Host sends its offer before the viewer ever verifies — buffered.
    await obj.webSocketMessage(asWs(host), control({ kind: 'offer', payload: 'never-should-survive' }));

    await obj.webSocketClose(asWs(host));

    // A fresh pairing on the same code must not see the stale buffered offer.
    const newHost = new FakeSocket();
    state.accept(newHost, ['host']);
    await pinRegister(obj, newHost, '654321');
    const newViewer = new FakeSocket();
    state.accept(newViewer, ['viewer']);
    await obj.webSocketMessage(asWs(newViewer), control({ type: 'pin', value: '654321' }));

    expect(newViewer.sent.some((m) => String(m).includes('never-should-survive'))).toBe(false);
  });
});

describe('SessionDurableObject — PIN-attempt race (SECURITY_AUDIT_20-08.md finding #5, Low)', () => {
  it('two wrong guesses submitted concurrently are still serialized: each gets a distinct, correctly-decrementing attemptsLeft', async () => {
    const { obj, state } = makeDo();
    const host = connectHost(state);
    const viewerA = connectViewer(state);
    await pinRegister(obj, host, '123456');

    // Fired without awaiting either first — the exact shape of the race:
    // both messages arrive close enough together that, pre-fix, both
    // doHandlePinVerify calls could read PIN_ATTEMPTS_KEY before either
    // wrote its decrement back.
    const first = obj.webSocketMessage(asWs(viewerA), control({ type: 'pin', value: '000000' }));
    const second = obj.webSocketMessage(asWs(viewerA), control({ type: 'pin', value: '111111' }));
    await Promise.all([first, second]);

    const failures = viewerA.sent
      .map((m) => JSON.parse(String(m)) as { type: string; attemptsLeft?: number })
      .filter((m) => m.type === 'pin-failed');

    expect(failures).toHaveLength(2);
    // Both attempts registered — 3 max minus 2 wrong guesses — never both
    // reading the same stale count and only decrementing once between them.
    const attemptsLeftSeen = failures.map((f) => f.attemptsLeft).sort();
    expect(attemptsLeftSeen).toEqual([1, 2]);
    expect(await state.storage.get<number>(PIN_ATTEMPTS_KEY)).toBe(1);
  });

  it('three concurrent wrong guesses lock the session exactly once, not more and not fewer times', async () => {
    const { obj, state } = makeDo();
    const host = connectHost(state);
    const viewer = connectViewer(state);
    await pinRegister(obj, host, '123456');

    await Promise.all([
      obj.webSocketMessage(asWs(viewer), control({ type: 'pin', value: '000000' })),
      obj.webSocketMessage(asWs(viewer), control({ type: 'pin', value: '111111' })),
      obj.webSocketMessage(asWs(viewer), control({ type: 'pin', value: '222222' })),
    ]);

    expect(viewer.closed).toEqual({ code: 1008, reason: 'pin-locked' });
    expect(await state.storage.get<number>(PIN_ATTEMPTS_KEY)).toBe(0);
  });
});

describe('SessionDurableObject — message-size cap and control/relay discrimination', () => {
  it('closes a socket that sends an oversized message before touching it as PIN or relay', async () => {
    const { obj, state } = makeDo();
    const host = connectHost(state);
    const huge = 'x'.repeat(64 * 1024 + 1);
    await obj.webSocketMessage(asWs(host), huge);
    expect(host.closed).toEqual({ code: 1009, reason: 'message-too-large' });
  });

  it('ignores messages from a socket with no recognized role tag', async () => {
    const { obj } = makeDo();
    const stray = new FakeSocket();
    await expect(obj.webSocketMessage(asWs(stray), control({ type: 'pin', value: '123456' }))).resolves.toBeUndefined();
  });

  it('a pin-register from the viewer role is ignored (only host may register)', async () => {
    const { obj, state } = makeDo();
    connectHost(state);
    const viewer = connectViewer(state);
    const hash = await hashPin('123456', CODE);
    await obj.webSocketMessage(asWs(viewer), control({ type: 'pin-register', hash }));
    expect(await state.storage.get(PIN_HASH_KEY)).toBeUndefined();
  });

  it('a pin verify from the host role is ignored (only viewer may verify)', async () => {
    const { obj, state } = makeDo();
    const host = connectHost(state);
    connectViewer(state);
    await pinRegister(obj, host, '123456');
    await obj.webSocketMessage(asWs(host), control({ type: 'pin', value: '123456' }));
    expect(await state.storage.get('pin-verified')).toBeUndefined();
  });
});
