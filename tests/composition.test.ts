import { describe, expect, it } from 'vitest';
import { composeApp } from '../src/composition.js';
import { fixtureEnv } from './fixtures/test-env.js';

describe('composition root', () => {
  it('test_compose_app_wires_config_from_injected_env', () => {
    const ctx = composeApp(fixtureEnv());
    expect(ctx.config.logLevel).toBe('silent');
    expect(ctx.config.appPort).toBe(8099);
  });
});
