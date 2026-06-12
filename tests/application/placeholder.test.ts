import { describe, expect, it } from 'vitest';
import { applicationLayerName } from '../../src/application/placeholder.js';

describe('application placeholder', () => {
  it('proves the application import path and the application->domain dependency resolve', () => {
    expect(applicationLayerName()).toBe('application');
  });
});
