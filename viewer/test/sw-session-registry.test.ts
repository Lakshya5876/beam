import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  createSessionRegistry,
  dropSession,
  gateFor,
  knownSessionFor,
  registerClientOwner,
  registerSessionSource,
  waitForClientOwner,
  REANNOUNCE_TIMEOUT_MS,
  type SessionRegistry,
} from '../src/sw-session-registry.js';
import { trackStreamOpen } from '../src/sw-fetch-gate.js';

// Fake WindowClient-like sources for two UNRELATED sessions sharing one SW.
const OUTER_A = { id: 'outer-client-A', postMessage: () => undefined };
const OUTER_B = { id: 'outer-client-B', postMessage: () => undefined };

describe('sw-session-registry — cross-session isolation (SECURITY_AUDIT_20-08.md finding #1, Critical)', () => {
  let registry: SessionRegistry;

  beforeEach(() => {
    vi.useFakeTimers();
    registry = createSessionRegistry();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('two concurrent sessions get two DISTINCT FetchGates, never a shared singleton', () => {
    const gateA = gateFor(registry, 'session-A-code');
    const gateB = gateFor(registry, 'session-B-code');
    expect(gateA).not.toBe(gateB);
    // Fetching the SAME session code again returns the SAME gate (stable identity).
    expect(gateFor(registry, 'session-A-code')).toBe(gateA);
  });

  it('registering session B does not overwrite session A\'s routing target — the exact bug the vulnerable singleton FetchGate had', () => {
    registerSessionSource(registry, 'session-A-code', OUTER_A);
    registerSessionSource(registry, 'session-B-code', OUTER_B);

    const gateA = gateFor(registry, 'session-A-code');
    const gateB = gateFor(registry, 'session-B-code');

    // Each session's gate must point at ITS OWN outer window, not whichever
    // one registered last. In the vulnerable implementation both of these
    // would have pointed at OUTER_B (the last mux-ready to arrive).
    expect(gateA.source).toBe(OUTER_A);
    expect(gateB.source).toBe(OUTER_B);
  });

  it('an iframe client registered to session A stays attributed to session A even after session B registers later', () => {
    registerSessionSource(registry, 'session-A-code', OUTER_A);
    registerClientOwner(registry, 'iframe-client-A', 'session-A-code');

    // Session B connects afterward, in a different tab, sharing the same SW.
    registerSessionSource(registry, 'session-B-code', OUTER_B);
    registerClientOwner(registry, 'iframe-client-B', 'session-B-code');

    // A fetch from iframe-client-A must still resolve to session A — a
    // regression here (both resolving to session B) is exactly the
    // confidentiality/integrity break the finding describes: session A's
    // tunneled app requests would be sent over session B's DataChannel to a
    // completely different local server.
    expect(knownSessionFor(registry, 'iframe-client-A')).toBe('session-A-code');
    expect(knownSessionFor(registry, 'iframe-client-B')).toBe('session-B-code');
  });

  it('each session enforces its own concurrent-stream cap independently (no shared budget to starve)', () => {
    registerSessionSource(registry, 'session-A-code', OUTER_A);
    const gateA = gateFor(registry, 'session-A-code');
    const gateB = gateFor(registry, 'session-B-code');
    trackStreamOpen(1, gateA);
    trackStreamOpen(2, gateA);
    expect(gateA.openStreams.size).toBe(2);
    // Session B's own stream accounting is untouched by A's activity.
    expect(gateB.openStreams.size).toBe(0);
  });

  it('registerClientOwner refuses an empty client id — never a routable map key', () => {
    registerClientOwner(registry, '', 'session-A-code');
    expect(knownSessionFor(registry, '')).toBeNull();
    // A later fetch with NO client id (a fresh navigation) must not
    // accidentally inherit whatever the empty-string key would have held.
    expect(registry.clientToSession.has('')).toBe(false);
  });

  it('knownSessionFor returns null for an empty or unregistered client id — never a guess', () => {
    registerSessionSource(registry, 'session-A-code', OUTER_A);
    expect(knownSessionFor(registry, '')).toBeNull();
    expect(knownSessionFor(registry, 'some-other-client')).toBeNull();
  });

  describe('waitForClientOwner — SW-restart recovery without cross-session guessing', () => {
    it('resolves immediately if the client is already known', async () => {
      registerClientOwner(registry, 'iframe-client-A', 'session-A-code');
      await expect(waitForClientOwner(registry, 'iframe-client-A', 1000)).resolves.toBe('session-A-code');
    });

    it('resolves once the client announces itself later', async () => {
      const promise = waitForClientOwner(registry, 'iframe-client-A', 5000);
      registerClientOwner(registry, 'iframe-client-A', 'session-A-code');
      await expect(promise).resolves.toBe('session-A-code');
    });

    it('resolves null on timeout rather than hanging or guessing another session', async () => {
      const promise = waitForClientOwner(registry, 'iframe-client-A', REANNOUNCE_TIMEOUT_MS);
      // A DIFFERENT client announces during the wait — must not satisfy A's wait.
      registerClientOwner(registry, 'iframe-client-B', 'session-B-code');
      vi.advanceTimersByTime(REANNOUNCE_TIMEOUT_MS + 1);
      await expect(promise).resolves.toBeNull();
    });

    it('resolves null for an empty client id without ever registering a waiter', async () => {
      await expect(waitForClientOwner(registry, '', 1000)).resolves.toBeNull();
    });
  });

  describe('tryBind — first-claim-wins (adversarial re-pass finding: forged iframe-owner confused deputy)', () => {
    // registerClientOwner is driven by an 'iframe-owner' message that ANY
    // script running inside the tunneled-app iframe can send — ordinarily
    // Beam's own trusted ws-shim.ts, but if the developer's own tunneled app
    // has an XSS vulnerability, attacker-controlled script there could send
    // one too, with no PIN needed, naming any session code it wants. These
    // tests prove that once a client id is legitimately bound, no later,
    // contradicting claim — however it arrives — can move it to a different
    // session and start receiving that session's relayed traffic.
    it('a second, different claim for an already-bound client id is rejected', () => {
      registerClientOwner(registry, 'iframe-client-A', 'session-A-code');
      const accepted = registerClientOwner(registry, 'iframe-client-A', 'session-B-code');

      expect(accepted).toBe(false);
      expect(knownSessionFor(registry, 'iframe-client-A')).toBe('session-A-code');
    });

    it('a repeated claim of the SAME session for an already-bound client id is accepted (idempotent)', () => {
      registerClientOwner(registry, 'iframe-client-A', 'session-A-code');
      const accepted = registerClientOwner(registry, 'iframe-client-A', 'session-A-code');

      expect(accepted).toBe(true);
      expect(knownSessionFor(registry, 'iframe-client-A')).toBe('session-A-code');
    });

    it('the first claim for a fresh client id is accepted', () => {
      const accepted = registerClientOwner(registry, 'iframe-client-A', 'session-A-code');
      expect(accepted).toBe(true);
      expect(knownSessionFor(registry, 'iframe-client-A')).toBe('session-A-code');
    });

    it('applies the same rule to registerSessionSource (the outer window)', () => {
      registerSessionSource(registry, 'session-A-code', OUTER_A);
      const rejected = registerSessionSource(registry, 'session-B-code', OUTER_A);

      expect(rejected).toBeNull();
      expect(knownSessionFor(registry, OUTER_A.id)).toBe('session-A-code');
    });

    it('an attacker who wins the FIRST claim for a client id still cannot later be displaced by the real session (the residual, narrower risk this cannot fully close — documented, not silently ignored)', () => {
      // If a forged claim somehow wins the very first bind (e.g. racing the
      // legitimate announcement immediately after an SW restart), tryBind's
      // guarantee is symmetric: the LEGITIMATE session's later, correct
      // claim is ALSO rejected once something else already holds the slot.
      // This documents that tryBind bounds the blast radius (no silent
      // takeover of an established binding) but is not a substitute for
      // never letting an untrusted context win the race in the first place
      // — see sw.ts resolveSession's doc for why the referrer path is
      // restricted to real navigations specifically to keep that race
      // unwinnable by page script in the first place.
      registerClientOwner(registry, 'iframe-client-A', 'attacker-chosen-code');
      const legitimate = registerClientOwner(registry, 'iframe-client-A', 'session-A-code');

      expect(legitimate).toBe(false);
      expect(knownSessionFor(registry, 'iframe-client-A')).toBe('attacker-chosen-code');
    });
  });

  describe('dropSession — a torn-down session can never be resolved again', () => {
    it('removes the gate and every client mapping that pointed at it', () => {
      registerSessionSource(registry, 'session-A-code', OUTER_A);
      registerClientOwner(registry, 'iframe-client-A', 'session-A-code');

      const dropped = dropSession(registry, 'session-A-code');
      expect(dropped).not.toBeNull();

      expect(knownSessionFor(registry, 'iframe-client-A')).toBeNull();
      expect(registry.gates.has('session-A-code')).toBe(false);
    });

    it('does not disturb an unrelated concurrent session', () => {
      registerSessionSource(registry, 'session-A-code', OUTER_A);
      registerSessionSource(registry, 'session-B-code', OUTER_B);
      registerClientOwner(registry, 'iframe-client-B', 'session-B-code');

      dropSession(registry, 'session-A-code');

      expect(knownSessionFor(registry, 'iframe-client-B')).toBe('session-B-code');
      expect(gateFor(registry, 'session-B-code').source).toBe(OUTER_B);
    });

    it('is idempotent — dropping an already-gone or unknown session is a safe no-op', () => {
      expect(dropSession(registry, 'never-existed')).toBeNull();
      registerSessionSource(registry, 'session-A-code', OUTER_A);
      dropSession(registry, 'session-A-code');
      expect(dropSession(registry, 'session-A-code')).toBeNull();
    });

    it('reports open streams and pending fetches for the caller to fail off, matching onMuxGone\'s contract', () => {
      registerSessionSource(registry, 'session-A-code', OUTER_A);
      const gateA = gateFor(registry, 'session-A-code');
      trackStreamOpen(5, gateA);
      trackStreamOpen(7, gateA);

      const dropped = dropSession(registry, 'session-A-code');
      expect(dropped?.openStreamIds).toEqual(expect.arrayContaining([5, 7]));
      expect(dropped?.pending).toEqual([]);
    });
  });
});
