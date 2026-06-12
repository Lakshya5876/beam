import { describe, expect, it } from 'vitest';
import { infrastructureLayerName } from '../../src/infrastructure/placeholder.js';

describe('infrastructure placeholder', () => {
  it('proves the infrastructure import path resolves', () => {
    expect(infrastructureLayerName()).toBe('infrastructure');
  });
});
