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
    expect(config.signalingUrl).toBeUndefined();
    expect(config.viewerUrl).toBeUndefined();
    expect(config.iceServers).toBeUndefined();
    expect(config.mintTimeoutMs).toBe(5000);
  });

  it('test_load_config_reads_deployment_endpoints_from_env', () => {
    const config = loadConfig({
      BEAM_SIGNALING_URL: 'wss://sig.example.com',
      BEAM_VIEWER_URL: 'https://view.example.com',
    });
    expect(config.signalingUrl).toBe('wss://sig.example.com');
    expect(config.viewerUrl).toBe('https://view.example.com');
  });

  it('test_load_config_parses_comma_separated_ice_servers', () => {
    const config = loadConfig({
      BEAM_ICE_SERVERS: 'stun:stun.example.com:3478, turn:user:pass@turn.example.com:3478',
    });
    expect(config.iceServers).toEqual(['stun:stun.example.com:3478', 'turn:user:pass@turn.example.com:3478']);
  });

  it('test_load_config_treats_empty_or_blank_ice_servers_as_unset', () => {
    expect(loadConfig({ BEAM_ICE_SERVERS: '' }).iceServers).toBeUndefined();
    expect(loadConfig({ BEAM_ICE_SERVERS: ' , ' }).iceServers).toBeUndefined();
  });

  it('test_load_config_mint_timeout_falls_back_on_invalid_values', () => {
    expect(loadConfig({ BEAM_MINT_TIMEOUT_MS: '2500' }).mintTimeoutMs).toBe(2500);
    expect(loadConfig({ BEAM_MINT_TIMEOUT_MS: 'soon' }).mintTimeoutMs).toBe(5000);
    expect(loadConfig({ BEAM_MINT_TIMEOUT_MS: '-1' }).mintTimeoutMs).toBe(5000);
  });
});
