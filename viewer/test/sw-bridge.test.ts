import { describe, it, expect } from 'vitest';
import { parseSwMessage, serializeSwMessage } from '../src/sw-bridge.js';

describe('sw-bridge', () => {
  describe('parseSwMessage', () => {
    it('parses mux-ready with sessionCode', () => {
      expect(parseSwMessage({ type: 'mux-ready', sessionCode: 'abc123' })).toEqual({
        type: 'mux-ready',
        sessionCode: 'abc123',
      });
    });

    it('returns null for mux-ready missing sessionCode', () => {
      expect(parseSwMessage({ type: 'mux-ready' })).toBeNull();
      expect(parseSwMessage({ type: 'mux-ready', sessionCode: 42 })).toBeNull();
    });

    it('parses request-mux-ready', () => {
      expect(parseSwMessage({ type: 'request-mux-ready' })).toEqual({ type: 'request-mux-ready' });
    });

    it('parses request-mux-ready and ignores extra fields', () => {
      expect(parseSwMessage({ type: 'request-mux-ready', extra: 'ignored' })).toEqual({
        type: 'request-mux-ready',
      });
    });

    it('returns null for unknown type', () => {
      expect(parseSwMessage({ type: 'unknown-type' })).toBeNull();
    });

    it('returns null for non-object inputs', () => {
      expect(parseSwMessage(null)).toBeNull();
      expect(parseSwMessage('string')).toBeNull();
      expect(parseSwMessage(42)).toBeNull();
      expect(parseSwMessage(undefined)).toBeNull();
    });

    it('returns null for object without type', () => {
      expect(parseSwMessage({})).toBeNull();
      expect(parseSwMessage({ sessionCode: 'abc' })).toBeNull();
    });

    it('parses relay-error with known reason', () => {
      const result = parseSwMessage({ type: 'relay-error', streamId: 1, reason: 'disconnect' });
      expect(result).toEqual({ type: 'relay-error', streamId: 1, reason: 'disconnect' });
    });

    it('returns null for relay-error with unknown reason', () => {
      expect(parseSwMessage({ type: 'relay-error', streamId: 1, reason: 'bad-reason' })).toBeNull();
    });
  });

  describe('serializeSwMessage / round-trip', () => {
    it('round-trips request-mux-ready through serialize then parse', () => {
      const msg = { type: 'request-mux-ready' } as const;
      const serialized = serializeSwMessage(msg);
      expect(parseSwMessage(serialized)).toEqual(msg);
    });

    it('round-trips mux-ready through serialize then parse', () => {
      const msg = { type: 'mux-ready', sessionCode: 'xyz789' } as const;
      const serialized = serializeSwMessage(msg);
      expect(parseSwMessage(serialized)).toEqual(msg);
    });
  });
});
