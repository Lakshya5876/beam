import { describe, expect, it } from 'vitest';
import { isWithinSizeCap, MAX_SIGNALING_MESSAGE_BYTES } from '../src/message-size.js';

describe('isWithinSizeCap', () => {
  it('accepts messages up to and including the cap', () => {
    expect(isWithinSizeCap(0)).toBe(true);
    expect(isWithinSizeCap(1024)).toBe(true);
    expect(isWithinSizeCap(MAX_SIGNALING_MESSAGE_BYTES)).toBe(true);
  });

  it('rejects messages above the cap', () => {
    expect(isWithinSizeCap(MAX_SIGNALING_MESSAGE_BYTES + 1)).toBe(false);
  });

  it('rejects negative or non-integer lengths', () => {
    expect(isWithinSizeCap(-1)).toBe(false);
    expect(isWithinSizeCap(1.5)).toBe(false);
  });

  it('honors a custom cap', () => {
    expect(isWithinSizeCap(100, 50)).toBe(false);
    expect(isWithinSizeCap(50, 50)).toBe(true);
  });
});
