/**
 * mDNS A-record resolver for Chrome WebRTC UUID.local hostnames.
 *
 * Chrome hides local IP addresses in ICE candidates behind temporary mDNS
 * hostnames (RFC 8828, e.g. ecc498da-....local) since Chrome 75. Three
 * resolution strategies are attempted in order:
 *
 *   1. macOS `dns-sd -G v4 <hostname>` — most reliable; goes through the
 *      Bonjour daemon (mDNSResponder) which sees Chrome's ephemeral records.
 *   2. Raw UDP multicast query to 224.0.0.251:5353 — cross-platform; works
 *      when the responder honours the unicast-response bit or multicast
 *      membership is joined.
 *   3. OS `dns.lookup()` with retries — last resort; may work after the
 *      mDNS record propagates to getaddrinfo (platform-dependent).
 *
 * No external dependencies — uses node:dgram, node:child_process, node:dns.
 */

import { createSocket } from 'node:dgram';
import { spawn } from 'node:child_process';

/** Build a DNS A-record query packet for mDNS (txid=0, unicast-response bit). */
export function buildMdnsQuery(hostname: string): Uint8Array {
  const parts: number[] = [
    0, 0,        // txid = 0 (mDNS)
    0, 0,        // flags = standard query
    0, 1,        // qdcount = 1
    0, 0,        // ancount = 0
    0, 0,        // nscount = 0
    0, 0,        // arcount = 0
  ];
  for (const label of hostname.split('.')) {
    parts.push(label.length);
    for (const char of label) {
      parts.push(char.charCodeAt(0));
    }
  }
  parts.push(0);       // end of name
  parts.push(0, 1);    // QTYPE = A
  parts.push(0x80, 1); // QCLASS = IN (0x0001) | unicast-response bit (0x8000)
  return new Uint8Array(parts);
}

/**
 * Read a DNS wire-format name starting at offset, following compression
 * pointers (RFC 1035 §4.1.4). Returns the decoded name and the offset of
 * the first byte AFTER the name (ignoring any pointer jumps).
 */
export function readDnsName(msg: Uint8Array, offset: number): { name: string; next: number } {
  const labels: string[] = [];
  let pos = offset;
  let jumped = false;
  let next = offset;

  while (pos < msg.length) {
    const len = msg[pos];
    if (len === undefined) break;
    if ((len & 0xc0) === 0xc0) {
      const ptr = ((len & 0x3f) << 8) | (msg[pos + 1] ?? 0);
      if (!jumped) next = pos + 2;
      pos = ptr;
      jumped = true;
    } else if (len === 0) {
      if (!jumped) next = pos + 1;
      break;
    } else {
      pos++;
      labels.push(String.fromCharCode(...msg.slice(pos, pos + len)));
      pos += len;
    }
  }

  return { name: labels.join('.'), next };
}

interface AnswerRR {
  name: string;
  type: number;
  rdlength: number;
  dataOffset: number;
  next: number;
}

function skipQuestions(msg: Uint8Array, qdcount: number, start: number): number {
  let offset = start;
  for (let i = 0; i < qdcount; i++) {
    const { next } = readDnsName(msg, offset);
    offset = next + 4; // skip QTYPE(2) + QCLASS(2)
  }
  return offset;
}

function readAnswerRR(msg: Uint8Array, offset: number): AnswerRR {
  const { name, next } = readDnsName(msg, offset);
  const type = ((msg[next] ?? 0) << 8) | (msg[next + 1] ?? 0);
  const rdlength = ((msg[next + 8] ?? 0) << 8) | (msg[next + 9] ?? 0);
  return { name, type, rdlength, dataOffset: next + 10, next: next + 10 + rdlength };
}

function ipFromARecord(msg: Uint8Array, offset: number): string {
  return `${msg[offset] ?? 0}.${msg[offset + 1] ?? 0}.${msg[offset + 2] ?? 0}.${msg[offset + 3] ?? 0}`;
}

/**
 * Scan the answer section of a DNS response for an A record matching
 * hostname. Returns the IPv4 address string, or null if not found.
 */
export function findARecord(msg: Uint8Array, hostname: string): string | null {
  if (msg.length < 12) return null;
  const qdcount = ((msg[4] ?? 0) << 8) | (msg[5] ?? 0);
  const ancount = ((msg[6] ?? 0) << 8) | (msg[7] ?? 0);
  let offset = skipQuestions(msg, qdcount, 12);

  for (let i = 0; i < ancount; i++) {
    const rr = readAnswerRR(msg, offset);
    if (rr.type === 1 && rr.rdlength === 4 && rr.name.toLowerCase() === hostname.toLowerCase()) {
      return ipFromARecord(msg, rr.dataOffset);
    }
    offset = rr.next;
  }
  return null;
}

/**
 * Resolve a UUID.local mDNS hostname by sending a raw DNS A-query to the
 * mDNS multicast group (224.0.0.251:5353) and waiting for a response.
 * Chrome's WebRTC mDNS stack responds to these queries.
 *
 * Joins the mDNS multicast group so multicast responses are received even
 * when the responder (e.g. Chrome) does not honour the unicast-response bit.
 */
export async function resolveMdnsHostname(hostname: string, timeoutMs = 2000): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const socket = createSocket({ type: 'udp4', reuseAddr: true });
    let closed = false;

    const done = (err?: Error, ip?: string): void => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      try { socket.close(); } catch { /* already closed */ }
      if (ip !== undefined) resolve(ip);
      else reject(err ?? new Error('mDNS: no result'));
    };

    const timer = setTimeout(() => {
      done(new Error(`mDNS: ${hostname} not found within ${timeoutMs}ms`));
    }, timeoutMs);

    socket.on('message', (msg) => {
      const buf = new Uint8Array(msg.buffer, msg.byteOffset, msg.byteLength);
      const ip = findARecord(buf, hostname);
      if (ip) done(undefined, ip);
    });

    socket.on('error', (err) => { done(err); });

    // Bind to an ephemeral port (not 5353 — that's privileged on macOS).
    // Join the multicast group so we receive multicast responses even when
    // the responder does not honour the unicast-response bit in QCLASS.
    socket.bind(0, () => {
      socket.setMulticastLoopback(true);
      try { socket.addMembership('224.0.0.251'); } catch { /* best-effort */ }
      const query = buildMdnsQuery(hostname);
      socket.send(Buffer.from(query), 5353, '224.0.0.251', (err) => {
        if (err) done(err);
      });
    });
  });
}

/**
 * Resolve a UUID.local hostname via the OS mDNS resolver (getaddrinfo) with
 * retries, since Chrome may need a brief moment after candidate generation
 * before the mDNS record is visible to other processes.
 */
export async function resolveMdnsViaSystem(hostname: string): Promise<string> {
  const { lookup } = await import('node:dns/promises');
  const RETRIES = 5;
  const DELAY_MS = 300;
  for (let i = 0; i < RETRIES; i++) {
    try {
      const result = await lookup(hostname, { family: 4 });
      return result.address;
    } catch {
      if (i < RETRIES - 1) await new Promise<void>((r) => { setTimeout(r, DELAY_MS); });
    }
  }
  throw new Error(`mDNS system: ${hostname} not found after ${RETRIES} retries`);
}

/**
 * Resolve a UUID.local hostname using macOS `dns-sd -G v4 <hostname>`.
 * This invokes Bonjour directly and reliably sees Chrome's ephemeral mDNS
 * records before they propagate to getaddrinfo. macOS only — throws on
 * other platforms so callers can fall through to the next strategy.
 */
export async function resolveMdnsViaDnsSd(hostname: string, timeoutMs = 3000): Promise<string> {
  if (process.platform !== 'darwin') {
    throw new Error('dns-sd is only available on macOS');
  }
  return new Promise<string>((resolve, reject) => {
    let settled = false;

    const child = spawn('dns-sd', ['-G', 'v4', hostname]);

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`dns-sd: ${hostname} not found within ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', (data: Buffer) => {
      if (settled) return;
      // dns-sd -G v4 emits lines like:
      //   HH:MM:SS.mmm  Add  2  0  <hostname>.  <ip>  ...
      const match = /\bAdd\b[^\n]*?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/.exec(data.toString());
      if (match?.[1]) {
        settled = true;
        clearTimeout(timer);
        child.kill();
        resolve(match[1]);
      }
    });

    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(e);
    });
  });
}

/**
 * Combined resolver — three strategies in priority order:
 *   1. `dns-sd -G v4` (macOS Bonjour daemon — most reliable)
 *   2. Raw UDP multicast query to 224.0.0.251:5353 (cross-platform)
 *   3. OS getaddrinfo with retries (last resort)
 */
export async function resolveWithFallback(hostname: string): Promise<string> {
  if (process.platform === 'darwin') {
    try {
      return await resolveMdnsViaDnsSd(hostname, 2000);
    } catch { /* fall through to raw UDP */ }
  }
  try {
    return await resolveMdnsHostname(hostname, 1500);
  } catch {
    return resolveMdnsViaSystem(hostname);
  }
}
