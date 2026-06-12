/**
 * Single source of truth for environment access (CLAUDE.md §3 SECURITY
 * INVARIANTS). Feature code never reads process.env directly — it receives
 * a BeamConfig. CORE_FILES member: editing semantics is a hard stop.
 */
export interface BeamConfig {
  readonly logLevel: string;
  readonly appPort: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BeamConfig {
  return {
    logLevel: env['BEAM_LOG_LEVEL'] ?? 'info',
    appPort: Number(env['APP_PORT'] ?? '8080'),
  };
}
