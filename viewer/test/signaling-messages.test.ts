import { describe, it, expect } from 'vitest';
import { parseMessage, serializeMessage } from '../src/signaling-messages.js';

describe('signaling-messages', () => {
  it('round-trips offer', () => {
    const sdp = 'v=0\r\no=user1 1234 1234 IN IP4 127.0.0.1\r\n...';
    const serialized = serializeMessage('offer', sdp);
    const parsed = parseMessage(serialized);
    expect(parsed).toEqual({ kind: 'offer', payload: sdp });
  });

  it('round-trips answer', () => {
    const sdp = 'v=0\r\no=user2 5678 5678 IN IP4 192.168.1.1\r\n...';
    const serialized = serializeMessage('answer', sdp);
    const parsed = parseMessage(serialized);
    expect(parsed).toEqual({ kind: 'answer', payload: sdp });
  });

  it('round-trips ice-candidate with mid', () => {
    const candidate = { candidate: 'candidate:1 1 UDP 2130706431 192.168.1.1 54321 typ host', mid: '0' };
    const serialized = serializeMessage('ice-candidate', candidate);
    const parsed = parseMessage(serialized);
    expect(parsed).toEqual({ kind: 'ice-candidate', payload: candidate });
  });

  it('round-trips ice-candidate without mid', () => {
    const candidate = { candidate: 'candidate:2 1 UDP 2130706430 10.0.0.1 54322 typ host' };
    const serialized = serializeMessage('ice-candidate', candidate);
    const parsed = parseMessage(serialized);
    expect(parsed).toEqual({ kind: 'ice-candidate', payload: candidate });
  });

  it('drops malformed JSON', () => {
    expect(parseMessage('not json')).toBeNull();
    expect(parseMessage('{incomplete')).toBeNull();
  });

  it('drops message with invalid kind', () => {
    const serialized = JSON.stringify({ kind: 'invalid', payload: 'sdp' });
    expect(parseMessage(serialized)).toBeNull();
  });

  it('drops message with missing payload', () => {
    const serialized = JSON.stringify({ kind: 'offer' });
    expect(parseMessage(serialized)).toBeNull();
  });

  it('drops ice-candidate with non-string candidate field', () => {
    const serialized = JSON.stringify({ kind: 'ice-candidate', payload: { candidate: 123, mid: '0' } });
    expect(parseMessage(serialized)).toBeNull();
  });

  it('drops non-object payload for offer/answer', () => {
    const serialized = JSON.stringify({ kind: 'offer', payload: 123 });
    expect(parseMessage(serialized)).toBeNull();
  });
});
