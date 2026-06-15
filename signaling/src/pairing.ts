/**
 * Session pairing logic (design §1 viewer/host pairing). PURE FUNCTIONS over
 * the roles currently present — deliberately NOT an in-memory state object,
 * because the WebSocket Hibernation API discards instance state between events.
 * The Durable Object derives `existingRoles` from the persisted socket tags
 * (which survive hibernation) and feeds them here.
 */

export type PeerRole = 'host' | 'viewer';

export type RoleAssignment = { readonly ok: true; readonly role: PeerRole } | { readonly ok: false; readonly reason: 'session-full' };

/** First peer to join a code is the host, the second the viewer, a third is rejected. */
export function assignRole(existingRoles: readonly PeerRole[]): RoleAssignment {
  if (!existingRoles.includes('host')) {
    return { ok: true, role: 'host' };
  }
  if (!existingRoles.includes('viewer')) {
    return { ok: true, role: 'viewer' };
  }
  return { ok: false, reason: 'session-full' };
}

/** A message from `senderRole` is relayed to the other peer. */
export function relayTargetRole(senderRole: PeerRole): PeerRole {
  return senderRole === 'host' ? 'viewer' : 'host';
}
