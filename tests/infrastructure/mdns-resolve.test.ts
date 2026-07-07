import { describe, expect, it } from 'vitest';
import { buildMdnsQuery, findARecord, readDnsName, resolveMdnsViaDnsSd } from '../../src/infrastructure/mdns-resolve.js';

// Canonical Chrome-style mDNS candidate hostname
const MDNS_HOST = 'ecc498da-5eba-41f1-870c-e7d9d7285d94.local';

// ---------------------------------------------------------------------------
// buildMdnsQuery — produces a valid DNS A-query packet
// ---------------------------------------------------------------------------
describe('buildMdnsQuery', () => {
  it('starts with txid=0 and query flags=0', () => {
    const q = buildMdnsQuery(MDNS_HOST);
    expect(q[0]).toBe(0);
    expect(q[1]).toBe(0); // txid = 0
    expect(q[2]).toBe(0);
    expect(q[3]).toBe(0); // flags = standard query
  });

  it('sets qdcount=1', () => {
    const q = buildMdnsQuery(MDNS_HOST);
    expect(q[4]).toBe(0);
    expect(q[5]).toBe(1);
  });

  it('ends with QTYPE=A and QCLASS=IN+unicast-response', () => {
    const q = buildMdnsQuery(MDNS_HOST);
    const last4 = q.slice(q.length - 4);
    expect(last4[0]).toBe(0);
    expect(last4[1]).toBe(1);    // QTYPE = A
    expect(last4[2]).toBe(0x80); // QCLASS high byte = unicast-response bit
    expect(last4[3]).toBe(1);    // QCLASS low byte = IN
  });

  it('encodes each label correctly', () => {
    const q = buildMdnsQuery('foo.local');
    // Header is 12 bytes, then: [3]foo[5]local[0] = 3+1+3+5+1+1 = 14 bytes of name
    expect(q[12]).toBe(3);    // len('foo')
    expect(q[13]).toBe(0x66); // 'f'
    expect(q[14]).toBe(0x6f); // 'o'
    expect(q[15]).toBe(0x6f); // 'o'
    expect(q[16]).toBe(5);    // len('local')
  });
});

// ---------------------------------------------------------------------------
// readDnsName — parses DNS wire-format names including compression pointers
// ---------------------------------------------------------------------------
describe('readDnsName', () => {
  it('reads a simple label sequence', () => {
    // Encode: [3]foo[5]local[0]
    const msg = new Uint8Array([3, 102, 111, 111, 5, 108, 111, 99, 97, 108, 0]);
    const { name, next } = readDnsName(msg, 0);
    expect(name).toBe('foo.local');
    expect(next).toBe(msg.length);
  });

  it('follows a compression pointer', () => {
    // 'foo.local' encoded at offset 0, pointer 0xC000 at offset 11
    const base = new Uint8Array([3, 102, 111, 111, 5, 108, 111, 99, 97, 108, 0]);
    const msg = new Uint8Array([...base, 0xc0, 0x00]); // pointer back to offset 0
    const { name, next } = readDnsName(msg, 11);
    expect(name).toBe('foo.local');
    expect(next).toBe(13); // pointer occupies 2 bytes
  });
});

// ---------------------------------------------------------------------------
// findARecord — extracts A record from a synthetic DNS response
// ---------------------------------------------------------------------------

function buildDnsResponse(hostname: string, ip: [number, number, number, number]): Uint8Array {
  // Encode the name
  const labels = hostname.split('.');
  const nameParts: number[] = [];
  for (const label of labels) {
    nameParts.push(label.length);
    for (const ch of label) nameParts.push(ch.charCodeAt(0));
  }
  nameParts.push(0);

  // Header: response, 0 questions, 1 answer
  const header = [
    0, 0,       // txid
    0x84, 0x00, // flags: response, authoritative
    0, 0,       // qdcount = 0
    0, 1,       // ancount = 1
    0, 0,       // nscount = 0
    0, 0,       // arcount = 0
  ];

  // Answer RR: [name][type=A][class=IN][ttl=120][rdlength=4][4-byte IP]
  const rr = [
    ...nameParts,
    0, 1,        // TYPE = A
    0, 1,        // CLASS = IN
    0, 0, 0, 120, // TTL = 120
    0, 4,        // RDLENGTH = 4
    ...ip,
  ];

  return new Uint8Array([...header, ...rr]);
}

describe('findARecord', () => {
  it('returns the IP when a matching A record is present', () => {
    const msg = buildDnsResponse(MDNS_HOST, [192, 168, 1, 5]);
    expect(findARecord(msg, MDNS_HOST)).toBe('192.168.1.5');
  });

  it('is case-insensitive for hostname comparison', () => {
    const msg = buildDnsResponse('FOO.LOCAL', [10, 0, 0, 1]);
    expect(findARecord(msg, 'foo.local')).toBe('10.0.0.1');
  });

  it('returns null when there are no answer records', () => {
    const msg = new Uint8Array([0, 0, 0x84, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(findARecord(msg, MDNS_HOST)).toBeNull();
  });

  it('returns null for a message shorter than the 12-byte header', () => {
    expect(findARecord(new Uint8Array([0, 0, 0]), MDNS_HOST)).toBeNull();
  });

  it('returns null when the A record hostname does not match', () => {
    const msg = buildDnsResponse('other.local', [1, 2, 3, 4]);
    expect(findARecord(msg, MDNS_HOST)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// resolveMdnsViaDnsSd — subprocess-based Bonjour resolver (macOS only)
// ---------------------------------------------------------------------------
describe('resolveMdnsViaDnsSd', () => {
  it('rejects immediately on non-macOS platforms', async () => {
    if (process.platform === 'darwin') {
      // Can't test non-darwin rejection on a darwin host. Skip.
      return;
    }
    await expect(resolveMdnsViaDnsSd(MDNS_HOST, 500)).rejects.toThrow('macOS');
  });

  it('rejects when dns-sd times out (no responder for fake hostname)', async () => {
    if (process.platform !== 'darwin') return;
    // The hostname does not exist, so dns-sd finds nothing within the short timeout.
    await expect(resolveMdnsViaDnsSd('nonexistent-uuid.local', 500)).rejects.toThrow();
  }, 2000);
});
