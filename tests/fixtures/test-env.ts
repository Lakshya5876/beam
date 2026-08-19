/**
 * Shared test fixtures.
 */
export function fixtureEnv(
  overrides: Record<string, string> = {},
): NodeJS.ProcessEnv {
  return { BEAM_LOG_LEVEL: 'silent', APP_PORT: '8099', ...overrides };
}
