import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { fixtureEnv } from './fixtures/test-env.js';

describe('config module', () => {
  it('test_load_config_reads_values_from_provided_env_only', () => {
    const config = loadConfig(fixtureEnv({ BEAM_LOG_LEVEL: 'debug' }));
    expect(config.logLevel).toBe('debug');
    expect(config.appPort).toBe(8099);
  });

  it('test_load_config_applies_documented_defaults_when_unset', () => {
    const config = loadConfig({});
    expect(config.logLevel).toBe('info');
    expect(config.appPort).toBe(8080);
  });
});
