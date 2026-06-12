/**
 * Placeholder proving the application import path and test mirror.
 * Replaced by F7/F8 (relay + session lifecycle use cases).
 * Application layer: orchestration only — no I/O, no HTTP concepts.
 */
import { domainLayerName } from '../domain/placeholder.js';

export function applicationLayerName(): string {
  // Proves the only legal inward dependency: application -> domain.
  return domainLayerName() === 'domain' ? 'application' : 'invalid';
}
