/**
 * Shared test fixtures. CORE_FILES member (tests/fixtures/**) — a change
 * here triggers tier-3 (full suite) once tiered selection is active,
 * because fixture injection is invisible to import-graph selection
 * (Guide §6.2 T4).
 */
export function fixtureEnv(
  overrides: Record<string, string> = {},
): NodeJS.ProcessEnv {
  return { BEAM_LOG_LEVEL: 'silent', APP_PORT: '8099', ...overrides };
}
