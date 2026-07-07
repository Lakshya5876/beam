/**
 * Loopback HTTP replay client (design doc §A.2.2, S5).
 * Implements the domain ReplayClient interface over node:http.
 *
 * Security invariants enforced structurally:
 *   - Connects ONLY to 127.0.0.1 (IPv4 literal) — never 0.0.0.0, never a
 *     hostname, never a viewer-supplied host.
 *   - The target port is a private readonly field set at construction. No
 *     argument, header, or path can redirect the request to another port;
 *     the request options are built solely from LOOPBACK_HOST + this.port.
 *   - Hop-by-hop and client-managed headers are stripped before send.
 *   - CR/LF in method, path, or any header name/value is rejected with a
 *     typed error BEFORE any socket write (no request splitting / smuggling).
 *   - Path traversal segments (`..`, `%2e%2e`, mixed encoding) are rejected
 *     before send — prevents `/../` and encoded-dot bypasses reaching the
 *     local server when it serves static files.
 *   - replay() is total: it never throws or rejects; every failure resolves
 *     to a typed ReplayFailedError carrying no stack trace.
 */

import http from 'node:http';
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import {
  err,
  ok,
  type ReplayClient,
  type ReplayFailedError,
  type ReplayRequest,
  type ReplayResponse,
  type Result,
} from '../domain/interfaces.js';

const LOOPBACK_HOST = '127.0.0.1';

const HOP_BY_HOP_HEADERS: ReadonlySet<string> = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

// Headers the client owns; a viewer-supplied value is never honored.
const CLIENT_MANAGED_HEADERS: ReadonlySet<string> = new Set(['host', 'content-length']);

type Resolve = (result: Result<ReplayResponse, ReplayFailedError>) => void;

function containsControlChars(value: string): boolean {
  // Block CR, LF (request splitting) and NUL (path truncation on vulnerable servers).
  return /[\r\n\0]/.test(value);
}

/**
 * Detect path traversal patterns in the path-only portion of a request path
 * (before the query string). Blocks `..` segments, percent-encoded double
 * dots (`%2e%2e`, `.%2e`, `%2e.`), and encoded slashes (`%2f`) which could
 * combine with dots to form traversal sequences across decode boundaries.
 */
function containsPathTraversal(rawPath: string): boolean {
  const pathOnly = rawPath.split('?')[0] ?? rawPath;
  if (/(?:^|\/)\.\.(?:\/|$)/.test(pathOnly)) return true;
  if (/%2e%2e|%2e\.|\.%2e|%2f/i.test(pathOnly)) return true;
  return false;
}

function fail(reason: string): ReplayFailedError {
  return { error: 'ReplayFailed', reason };
}

/** Extract a safe, non-leaking reason — never a stack trace or raw message. */
function safeReason(error: unknown): string {
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : 'request failed';
}

function flattenHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) {
      continue;
    }
    out[name] = Array.isArray(value) ? value.join(', ') : value;
  }
  return out;
}

function toResponse(res: IncomingMessage, chunks: Buffer[]): ReplayResponse {
  const body = Buffer.concat(chunks);
  return {
    status: res.statusCode ?? 0,
    headers: flattenHeaders(res.headers),
    body: new Uint8Array(body),
  };
}

export class LoopbackReplayClient implements ReplayClient {
  constructor(
    private readonly port: number,
    private readonly timeoutMs = 30_000,
  ) {}

  replay(request: ReplayRequest): Promise<Result<ReplayResponse, ReplayFailedError>> {
    const headers = this.validate(request);
    if (!headers.ok) {
      return Promise.resolve(headers);
    }
    return this.send(request, headers.value);
  }

  private validate(request: ReplayRequest): Result<Record<string, string>, ReplayFailedError> {
    if (containsControlChars(request.method)) {
      return err(fail('method contains control characters'));
    }
    if (containsControlChars(request.path)) {
      return err(fail('path contains control characters'));
    }
    if (containsPathTraversal(request.path)) {
      return err(fail('path traversal not permitted'));
    }
    return this.sanitizeHeaders(request.headers);
  }

  private sanitizeHeaders(input: Readonly<Record<string, string>>): Result<Record<string, string>, ReplayFailedError> {
    const out: Record<string, string> = {};
    for (const [name, value] of Object.entries(input)) {
      if (containsControlChars(name) || containsControlChars(value)) {
        return err(fail('header contains control characters'));
      }
      const lower = name.toLowerCase();
      if (HOP_BY_HOP_HEADERS.has(lower) || CLIENT_MANAGED_HEADERS.has(lower)) {
        continue;
      }
      out[name] = value;
    }
    return ok(out);
  }

  private finalHeaders(headers: Record<string, string>, contentLength: number): Record<string, string> {
    return {
      ...headers,
      host: `${LOOPBACK_HOST}:${String(this.port)}`,
      'content-length': String(contentLength),
    };
  }

  private send(request: ReplayRequest, headers: Record<string, string>): Promise<Result<ReplayResponse, ReplayFailedError>> {
    // The executor wraps node:http so any synchronous throw surfaces as a
    // typed ReplayFailedError (totality), never as a rejected promise.
    return new Promise<Result<ReplayResponse, ReplayFailedError>>((resolve) => {
      try {
        this.dispatch(request, headers, resolve);
      } catch (error) {
        resolve(err(fail(safeReason(error))));
      }
    });
  }

  private dispatch(request: ReplayRequest, headers: Record<string, string>, resolve: Resolve): void {
    const req = http.request(
      {
        host: LOOPBACK_HOST,
        port: this.port,
        method: request.method,
        path: request.path,
        headers: this.finalHeaders(headers, request.body.byteLength),
        timeout: this.timeoutMs,
      },
      (res) => {
        collect(res, resolve);
      },
    );
    req.on('error', (error) => {
      resolve(err(fail(safeReason(error))));
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(err(fail('request timed out')));
    });
    req.end(request.body);
  }
}

function collect(res: IncomingMessage, resolve: Resolve): void {
  const chunks: Buffer[] = [];
  res.on('data', (chunk: Buffer) => {
    chunks.push(chunk);
  });
  res.on('end', () => {
    resolve(ok(toResponse(res, chunks)));
  });
  res.on('error', (error) => {
    resolve(err(fail(safeReason(error))));
  });
}
