/**
 * Debug/diagnostics rendering for the CLI (presentation layer — pure
 * formatting, no I/O). Three surfaces:
 *
 *   createTimestampedLogger — wraps a sink so every infrastructure debug line
 *     becomes a connection-timeline entry: `[+1.234s] [HOST-PC] ...`.
 *   explainConnectFailure — maps the bounded PeerConnectFailed reasons to
 *     human-readable causes + next steps (printed on failure, debug or not).
 *   describeSessionEvent — one status line per domain session event so the
 *     CLI shows connecting → connected/failed instead of silence.
 */

import type { SessionEvent } from '../domain/session.js';

/** Prefix each line with elapsed seconds since logger creation. */
export function createTimestampedLogger(
  sink: (line: string) => void,
  now: () => number = () => Date.now(),
): (msg: string) => void {
  const startedAt = now();
  return (msg: string): void => {
    const elapsed = ((now() - startedAt) / 1000).toFixed(3);
    sink(`[+${elapsed}s] ${msg}`);
  };
}

/**
 * ICE candidate type from a raw candidate string (`... typ host ...`).
 * host/prflx/srflx = direct path possible; relay = TURN.
 */
export function candidateType(candidate: string): 'host' | 'srflx' | 'prflx' | 'relay' | null {
  const m = /\btyp\s+(host|srflx|prflx|relay)\b/.exec(candidate);
  return (m?.[1] as 'host' | 'srflx' | 'prflx' | 'relay' | undefined) ?? null;
}

/** Human-readable causes and next steps for each bounded failure reason. */
export function explainConnectFailure(reason: string): string {
  switch (reason) {
    case 'no-viable-candidate':
      return [
        'No network path to the viewer was found (ICE failed).',
        'Likely causes:',
        '  - both peers are behind symmetric NAT (STUN alone cannot traverse: see LIMITATIONS.md)',
        '  - a firewall blocks UDP entirely',
        '  - the configured STUN/TURN server is unreachable (check --ice / BEAM_ICE_SERVERS)',
        'Retry with --debug to see which candidate types were gathered:',
        '  no srflx candidates -> STUN is blocked or misconfigured.',
      ].join('\n');
    case 'connect-timeout':
      return [
        'The viewer never completed the WebRTC handshake in time.',
        'Likely causes:',
        '  - the viewer closed the page or never entered the PIN',
        '  - signaling delivered the offer but ICE is still blocked mid-handshake',
        'Retry with --debug: if no remote candidates appear, signaling relay is the problem;',
        'if candidates appear but no DataChannel OPEN, the network path is.',
      ].join('\n');
    case 'closed-before-open':
      return 'The connection was closed before it finished opening (usually Ctrl-C or the viewer disconnecting mid-handshake).';
    default:
      return `Connection failed: ${reason}`;
  }
}

/** One CLI status line per session event; null when nothing should print. */
export function describeSessionEvent(event: SessionEvent): string | null {
  switch (event.event) {
    case 'SessionEstablished':
      return '  Peer connected — relaying traffic. Requests appear below.';
    case 'SessionFailed':
      return `  Connection failed.\n${indent(explainConnectFailure(event.reason), 2)}`;
    case 'SessionClosed':
      return `  Session closed (${event.reason}).`;
    default:
      return null;
  }
}

function indent(text: string, spaces: number): string {
  const pad = ' '.repeat(spaces);
  return text.split('\n').map((line) => `${pad}${line}`).join('\n');
}
