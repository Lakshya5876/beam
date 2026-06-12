import { describe, expect, it } from 'vitest';
import { domainLayerName } from '../../src/domain/placeholder.js';

describe('domain placeholder', () => {
  it('proves the domain import path resolves', () => {
    expect(domainLayerName()).toBe('domain');
  });
});
