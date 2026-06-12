/**
 * Composition root — the ONLY place concrete infrastructure is wired to
 * domain interfaces. CORE_FILES member: editing is reviewed as DI wiring.
 */
import { loadConfig, type BeamConfig } from './config.js';

export interface AppContext {
  readonly config: BeamConfig;
}

// Environment access stays inside src/config.ts (CLAUDE.md §3) — omitting
// the arg lets loadConfig apply its own default from the config module.
export function composeApp(env?: NodeJS.ProcessEnv): AppContext {
  return { config: loadConfig(env) };
}
