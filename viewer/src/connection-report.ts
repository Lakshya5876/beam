/**
 * Connection lifecycle observability for the viewer.
 *
 * The product problem this solves: every failure used to surface as the same
 * "Connection failed: peer connection failed", which cannot distinguish
 * "we never reached the signaling server" from "WebRTC connected but the
 * relay protocol broke" — the single most important distinction when
 * diagnosing a user's session. Each stage is recorded as it is reached, so a
 * failure reports the LAST stage actually reached plus what was available at
 * the time (notably whether a TURN relay path existed at all).
 *
 * Deliberately carries no application data: stage names, ICE candidate types,
 * and Beam's own typed failure tags only — never request paths, headers,
 * bodies, or anything the tunneled app sent.
 *
 * Pure: no DOM, no clock, no I/O.
 */

/** Ordered — each stage implies every earlier one was reached. */
export const CONNECTION_STAGES = [
  'signaling-connect',
  'pin-verify',
  'ice-config',
  'sdp-exchange',
  'ice-gathering',
  'ice-connect',
  'datachannel-open',
  'relay-ready',
] as const;

export type ConnectionStage = (typeof CONNECTION_STAGES)[number];

/** Which ICE candidate pair carried the session, once one is nominated. */
export type SelectedPath = 'direct' | 'relay' | 'unknown';

export interface ConnectionFacts {
  readonly reachedStage: ConnectionStage | null;
  readonly turnAvailable: boolean;
  readonly turnDiagnostic: string | null;
  readonly selectedPath: SelectedPath;
  readonly relayOnlyRequested: boolean;
}

export class ConnectionReport {
  private reached: ConnectionStage | null = null;
  private turnAvailable = false;
  private turnDiagnostic: string | null = null;
  private selectedPath: SelectedPath = 'unknown';
  private relayOnly = false;

  /** Record a stage. Never moves backwards, so an out-of-order or repeated
   *  event cannot make the report understate progress. */
  reach(stage: ConnectionStage): void {
    const next = CONNECTION_STAGES.indexOf(stage);
    const current = this.reached === null ? -1 : CONNECTION_STAGES.indexOf(this.reached);
    if (next > current) {
      this.reached = stage;
    }
  }

  /** `x-beam-turn` from /ice-config: 'available', 'not-configured', or a
   *  typed mint failure. Anything else is treated as no relay available. */
  noteTurnState(header: string | null, sawRelayServer: boolean): void {
    this.turnDiagnostic = header;
    this.turnAvailable = sawRelayServer;
  }

  noteRelayOnlyRequested(): void {
    this.relayOnly = true;
  }

  noteSelectedPath(path: SelectedPath): void {
    this.selectedPath = path;
  }

  facts(): ConnectionFacts {
    return {
      reachedStage: this.reached,
      turnAvailable: this.turnAvailable,
      turnDiagnostic: this.turnDiagnostic,
      selectedPath: this.selectedPath,
      relayOnlyRequested: this.relayOnly,
    };
  }

  /** True once WebRTC itself succeeded — the boundary between a transport
   *  failure and an application/relay failure. */
  transportEstablished(): boolean {
    return this.reached !== null && CONNECTION_STAGES.indexOf(this.reached) >= CONNECTION_STAGES.indexOf('datachannel-open');
  }
}

/**
 * A user-facing explanation of a failure: what stage it died at, and the most
 * likely cause given what was available. Kept to plain language — the stage
 * tag is appended for support/debugging rather than being the whole message.
 */
export function describeFailure(facts: ConnectionFacts): string {
  const stage = facts.reachedStage;
  if (stage === null) {
    return 'Could not reach the Beam signaling server. Check your network connection. [stage: none]';
  }
  switch (stage) {
    case 'signaling-connect':
      return 'Connected to Beam, but the session did not start. The host may have closed it. [stage: signaling-connect]';
    case 'pin-verify':
      return 'Session code accepted, but the host never sent a connection offer. The host may have disconnected. [stage: pin-verify]';
    case 'ice-config':
    case 'sdp-exchange':
    case 'ice-gathering':
    case 'ice-connect':
      return `${directPathAdvice(facts)} [stage: ${stage}]`;
    case 'datachannel-open':
      return 'Connected to the host, but the page could not be loaded through the tunnel. [stage: datachannel-open]';
    case 'relay-ready':
      return 'The tunnel was connected but then dropped. [stage: relay-ready]';
  }
}

/**
 * The network-level failure case, which is where TURN matters: say plainly
 * whether a relay path was even available, since "no viable path" with TURN
 * unavailable is a deployment problem, not a user problem.
 */
function directPathAdvice(facts: ConnectionFacts): string {
  if (facts.relayOnlyRequested) {
    return 'Could not connect through the TURN relay (relay-only mode was requested).';
  }
  if (facts.turnAvailable) {
    return 'Could not establish a connection to the host, directly or through the relay. The host may be offline or behind a restrictive firewall.';
  }
  const reason = facts.turnDiagnostic !== null && facts.turnDiagnostic !== 'not-configured'
    ? ` (relay unavailable: ${facts.turnDiagnostic})`
    : ' (no relay server is configured for this deployment)';
  return `Could not establish a direct connection to the host, and no relay fallback was available${reason}.`;
}

/** `?relay=1` — force TURN. Verification/diagnosis only; see host config.ts. */
export function isRelayOnlyRequested(search: string): boolean {
  return new URLSearchParams(search).get('relay') === '1';
}

/**
 * Classify a nominated ICE candidate pair. Chrome/Firefox/Safari all expose
 * candidateType on the stats entries; 'relay' on EITHER end means TURN
 * carried the traffic.
 */
export function classifySelectedPath(localType: string | undefined, remoteType: string | undefined): SelectedPath {
  if (localType === undefined && remoteType === undefined) {
    return 'unknown';
  }
  return localType === 'relay' || remoteType === 'relay' ? 'relay' : 'direct';
}
