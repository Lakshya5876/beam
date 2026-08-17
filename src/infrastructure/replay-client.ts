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
 *
 * Streaming: response bytes are handed to the ReplaySink as they arrive from
 * the upstream socket (res 'data' events), not buffered to 'end' first — the
 * previous buffer-then-relay design stalled forever on a response that never
 * ends (SSE, long-polling) and held arbitrarily large bodies in host memory.
 * Each res 'data' event pauses the IncomingMessage and awaits the sink before
 * resuming, so downstream backpressure (the DataChannel mux's high-water
 * mark, threaded through the sink by the caller) throttles the upstream
 * socket via ordinary Node stream flow control instead of an unbounded queue.
 */

import http from 'node:http';
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import {
  err,
  ok,
  type ReplayClient,
  type ReplayFailedError,
  type ReplayRequest,
  type ReplaySink,
  type Result,
} from '../domain/interfaces.js';
import { containsControlChars, containsPathTraversal, LOOPBACK_HOST } from './loopback-validation.js';

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

type Resolve = (result: Result<undefined, ReplayFailedError>) => void;

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

export class LoopbackReplayClient implements ReplayClient {
  constructor(
    private readonly port: number,
    private readonly timeoutMs = 30_000,
  ) {}

  replay(request: ReplayRequest, sink: ReplaySink): Promise<Result<undefined, ReplayFailedError>> {
    const headers = this.validate(request);
    if (!headers.ok) {
      return Promise.resolve(headers);
    }
    return this.send(request, headers.value, sink);
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

  private send(request: ReplayRequest, headers: Record<string, string>, sink: ReplaySink): Promise<Result<undefined, ReplayFailedError>> {
    // The executor wraps node:http so any synchronous throw surfaces as a
    // typed ReplayFailedError (totality), never as a rejected promise.
    return new Promise<Result<undefined, ReplayFailedError>>((resolve) => {
      try {
        this.dispatch(request, headers, sink, resolve);
      } catch (error) {
        resolve(err(fail(safeReason(error))));
      }
    });
  }

  private dispatch(request: ReplayRequest, headers: Record<string, string>, sink: ReplaySink, resolve: Resolve): void {
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
        void streamResponse(res, sink, resolve);
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

/**
 * Stream the upstream response into `sink` one 'data' event at a time,
 * pausing the socket and awaiting the sink before resuming — the standard
 * Node backpressure idiom, so a congested downstream mux throttles the
 * upstream socket via TCP flow control instead of buffering in this process.
 */
async function streamResponse(res: IncomingMessage, sink: ReplaySink, resolve: Resolve): Promise<void> {
  let settled = false;
  const finish = (result: Result<undefined, ReplayFailedError>): void => {
    if (settled) {
      return;
    }
    settled = true;
    resolve(result);
  };

  try {
    await sink.onHead({ status: res.statusCode ?? 0, headers: flattenHeaders(res.headers) });
  } catch (error) {
    finish(err(fail(safeReason(error))));
    res.destroy();
    return;
  }

  res.on('data', (chunk: Buffer) => {
    if (settled) {
      return;
    }
    res.pause();
    void (async (): Promise<void> => {
      try {
        await sink.onChunk(new Uint8Array(chunk));
        if (!settled) {
          res.resume();
        }
      } catch (error) {
        finish(err(fail(safeReason(error))));
        res.destroy();
      }
    })();
  });
  res.on('end', () => {
    void (async (): Promise<void> => {
      try {
        await sink.onEnd();
      } catch {
        // Best-effort: the response already fully arrived, nothing to abort.
      }
      finish(ok(undefined));
    })();
  });
  res.on('error', (error) => {
    finish(err(fail(safeReason(error))));
  });
}
