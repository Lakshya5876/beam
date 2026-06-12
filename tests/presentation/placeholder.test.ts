import { describe, expect, it } from 'vitest';
import { presentationLayerName } from '../../src/presentation/placeholder.js';

describe('presentation placeholder', () => {
  it('proves the presentation import path resolves', () => {
    expect(presentationLayerName()).toBe('presentation');
  });
});
