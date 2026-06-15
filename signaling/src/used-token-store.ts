/**
 * Storage-backed used-token store (design §A.2.3/§A.5). Implements the S14a
 * UsedTokenStore (sync has/add) over a hydrated in-memory set plus a persister
 * that writes each newly-used code to durable storage. The Durable Object
 * hydrates `known` from storage at construction and supplies a persister that
 * writes to DO storage; this keeps the never-reuse guard sync (so S14a's
 * mintUnusedCode works unchanged) while persisting across instances/hibernation.
 */

import type { UsedTokenStore } from './session-code.js';

export interface TokenPersister {
  put(code: string): void;
}

export class StorageUsedTokenStore implements UsedTokenStore {
  constructor(
    private readonly known: Set<string>,
    private readonly persister: TokenPersister,
  ) {}

  has(code: string): boolean {
    return this.known.has(code);
  }

  add(code: string): void {
    if (!this.known.has(code)) {
      this.known.add(code);
      this.persister.put(code);
    }
  }
}
