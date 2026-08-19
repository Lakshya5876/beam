/**
 * ICE server parsing and composition — the pure half of Beam's ICE handling.
 *
 * Beam carries ICE servers as the domain's provider-neutral IceServerConfig.
 * This module turns the two textual forms Beam accepts (an /ice-config JSON
 * body, and the legacy comma-separated BEAM_ICE_SERVERS env value) into that
 * type, and composes lists in ICE-preference order. Conversion to
 * node-datachannel's own config shape belongs to the transport adapter that
 * owns that dependency (infrastructure/peer-connection.ts), not here.
 *
 * Every parser is total: malformed input is dropped, never thrown, because
 * bad ICE configuration must degrade the connection's options rather than
 * fail the session outright.
 *
 * Pure: no I/O, no clock, no env access.
 */

import type { IceServerConfig } from '../domain/interfaces.js';

export type { IceServerConfig };

export type IceScheme = 'stun' | 'stuns' | 'turn' | 'turns';
export type IceTransport = 'udp' | 'tcp';

export interface ParsedIceUrl {
  readonly scheme: IceScheme;
  readonly host: string;
  readonly port: number;
  readonly transport: IceTransport;
}

const DEFAULT_PORTS: Readonly<Record<IceScheme, number>> = {
  stun: 3478,
  stuns: 5349,
  turn: 3478,
  turns: 5349,
};

const SCHEMES: ReadonlySet<string> = new Set(['stun', 'stuns', 'turn', 'turns']);

function isScheme(value: string): value is IceScheme {
  return SCHEMES.has(value);
}

/** Split `<rest>[?query]`, reading only the transport parameter. */
function splitTransport(rest: string): { authority: string; transport: IceTransport } {
  const queryStart = rest.indexOf('?');
  if (queryStart < 0) {
    return { authority: rest, transport: 'udp' };
  }
  const query = rest.slice(queryStart + 1).toLowerCase();
  return {
    authority: rest.slice(0, queryStart),
    transport: /(^|&)transport=tcp(&|$)/.test(query) ? 'tcp' : 'udp',
  };
}

/**
 * Split `<host>[:<port>]`. IPv6 literals are bracketed (`[::1]:3478`), so the
 * port separator is searched from the closing bracket onward — otherwise the
 * address's own colons would be read as a port.
 */
function splitHostPort(authority: string, defaultPort: number): { host: string; port: number } | null {
  const searchFrom = authority.startsWith('[') ? authority.indexOf(']') : 0;
  if (searchFrom < 0) {
    return null;
  }
  const portSep = authority.indexOf(':', searchFrom);
  if (portSep < 0) {
    return authority.length > 0 ? { host: authority, port: defaultPort } : null;
  }
  const host = authority.slice(0, portSep);
  const port = Number(authority.slice(portSep + 1));
  if (host.length === 0 || !Number.isInteger(port) || port <= 0 || port > 65535) {
    return null;
  }
  return { host, port };
}

/**
 * Parse an ICE URL: `<scheme>:<host>[:<port>][?transport=udp|tcp]`.
 *
 * Deliberately not `new URL()`: ICE URLs are RFC 7064/7065 URIs, not
 * hierarchical URLs — they have no `//`, so `new URL('turn:host:3478')`
 * yields pathname='host:3478' and no host/port at all. Total: anything
 * malformed yields null rather than throwing.
 */
export function parseIceUrl(raw: string): ParsedIceUrl | null {
  const trimmed = raw.trim();
  const schemeEnd = trimmed.indexOf(':');
  if (schemeEnd <= 0) {
    return null;
  }
  const scheme = trimmed.slice(0, schemeEnd).toLowerCase();
  if (!isScheme(scheme)) {
    return null;
  }
  const { authority, transport } = splitTransport(trimmed.slice(schemeEnd + 1));
  const hostPort = splitHostPort(authority, DEFAULT_PORTS[scheme]);
  return hostPort === null ? null : { scheme, host: hostPort.host, port: hostPort.port, transport };
}

/**
 * True when an entry is a TURN server carrying the credentials TURN requires.
 * A TURN entry without credentials is unusable — it yields no relay candidate
 * — so it must not be counted as relay coverage.
 */
export function isUsableRelay(entry: IceServerConfig): boolean {
  const parsed = parseIceUrl(entry.urls);
  if (!parsed || (parsed.scheme !== 'turn' && parsed.scheme !== 'turns')) {
    return false;
  }
  return entry.username !== undefined && entry.credential !== undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `urls` may be a single string or an array, per the WebRTC dictionary. */
function urlsOf(value: Record<string, unknown>): string[] {
  const raw = value['urls'] ?? value['url'];
  if (typeof raw === 'string') {
    return [raw];
  }
  return Array.isArray(raw) ? raw.filter((u): u is string => typeof u === 'string') : [];
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  return typeof field === 'string' ? field : undefined;
}

/**
 * Normalize one RTCIceServer-shaped object, expanding a `urls` array into one
 * entry per URL so every downstream consumer handles exactly one URL per
 * entry. Credentials are carried onto each expansion — a provider returns one
 * credential covering several transports of the same relay.
 */
function normalizeEntry(value: unknown): IceServerConfig[] {
  if (!isRecord(value)) {
    return [];
  }
  const username = stringField(value, 'username');
  const credential = stringField(value, 'credential');
  const out: IceServerConfig[] = [];
  for (const url of urlsOf(value)) {
    const trimmed = url.trim();
    if (!parseIceUrl(trimmed)) {
      continue;
    }
    out.push({
      urls: trimmed,
      ...(username !== undefined && { username }),
      ...(credential !== undefined && { credential }),
    });
  }
  return out;
}

/**
 * Parse an /ice-config response body's `iceServers` value, or a bare array of
 * RTCIceServer objects (the shape TURN providers return directly). Total:
 * anything unrecognized yields an empty list, never a throw — the caller
 * falls back to its own defaults rather than failing the connection.
 */
export function parseIceServerList(value: unknown): IceServerConfig[] {
  const array = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value['iceServers'])
      ? value['iceServers']
      : null;
  if (!array) {
    return [];
  }
  const out: IceServerConfig[] = [];
  for (const entry of array) {
    out.push(...normalizeEntry(entry));
  }
  return out;
}

/**
 * Identity for de-duplication: URL plus username. The same TURN host may
 * legitimately appear under two credentials (a static one from env and a
 * freshly minted one); keeping both is correct, since either may be the one
 * that works.
 */
function identityOf(entry: IceServerConfig): string {
  return `${entry.urls.toLowerCase()}|${entry.username ?? ''}`;
}

/** Concatenate ICE server lists in priority order, dropping exact duplicates. */
export function mergeIceServers(...lists: ReadonlyArray<readonly IceServerConfig[]>): IceServerConfig[] {
  const seen = new Set<string>();
  const out: IceServerConfig[] = [];
  for (const list of lists) {
    for (const entry of list) {
      const identity = identityOf(entry);
      if (seen.has(identity)) {
        continue;
      }
      seen.add(identity);
      out.push(entry);
    }
  }
  return out;
}

/** True when the list contains at least one usable TURN (relay) server. */
export function hasRelayServer(entries: readonly IceServerConfig[]): boolean {
  return entries.some(isUsableRelay);
}

/**
 * Parse the legacy BEAM_ICE_SERVERS form: a bare URL, optionally carrying
 * credentials inline as `turn:user:pass@host:port` (documented in config.ts
 * since before TURN was minted server-side). Kept working so an existing
 * shell env or a self-hosted coturn continues to configure the host, but the
 * inline form stays limited to credentials without '@' or ':' — which is why
 * minted credentials travel as structured fields instead.
 */
export function parseIceServerUrl(raw: string): IceServerConfig | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const schemeEnd = trimmed.indexOf(':');
  if (schemeEnd <= 0) {
    return null;
  }
  const scheme = trimmed.slice(0, schemeEnd).toLowerCase();
  const rest = trimmed.slice(schemeEnd + 1);
  const at = rest.lastIndexOf('@');
  if (at < 0) {
    return parseIceUrl(trimmed) ? { urls: trimmed } : null;
  }
  const credentials = rest.slice(0, at);
  const hostPart = rest.slice(at + 1);
  const sep = credentials.indexOf(':');
  if (sep <= 0) {
    return null;
  }
  const url = `${scheme}:${hostPart}`;
  if (!parseIceUrl(url)) {
    return null;
  }
  return {
    urls: url,
    username: credentials.slice(0, sep),
    credential: credentials.slice(sep + 1),
  };
}

/** Parse a comma-separated BEAM_ICE_SERVERS value. Total; drops bad entries. */
export function parseIceServersEnv(raw: string | undefined): IceServerConfig[] {
  if (raw === undefined) {
    return [];
  }
  const out: IceServerConfig[] = [];
  for (const part of raw.split(',')) {
    const entry = parseIceServerUrl(part);
    if (entry) {
      out.push(entry);
    }
  }
  return out;
}
