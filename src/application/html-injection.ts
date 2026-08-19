/**
 * Injects a `<script>` tag into an HTML response stream, right after the
 * opening `<head>` or `<html>` tag — so the injected script is the FIRST
 * thing the browser executes in that document (before any of the tunneled
 * app's own scripts, including its head-inline synchronous ones; module
 * scripts are deferred by the platform regardless of position). This is how
 * the WebSocket shim (viewer/src/ws-shim.ts) gets into a page a service
 * worker cannot otherwise reach — a SW can intercept `fetch()`, but there is
 * no equivalent hook for `new WebSocket()`.
 *
 * Byte-level, not string-level: response bodies stream in arbitrary chunk
 * boundaries, which can split a multi-byte UTF-8 sequence. Decoding only for
 * the SEARCH (never for the bytes actually forwarded) with a non-fatal
 * TextDecoder is safe here because the tag markers we look for are pure
 * ASCII and always appear extremely early in any real HTML document — a
 * transient decode artifact from a split boundary just means "not found
 * yet, keep buffering," which self-heals once more bytes arrive.
 *
 * Bounded lookahead: if `<head` or `<html` hasn't appeared within
 * MAX_LOOKAHEAD_BYTES, injection is abandoned and everything buffered is
 * flushed unmodified — never buffers an entire large document hunting for a
 * tag that isn't there (or was already flushed in an earlier, tag-less chunk
 * of a document that starts unusually, e.g. an XML prolog before `<html>`).
 */

const MAX_LOOKAHEAD_BYTES = 8192;

function isAsciiLetter(byte: number | undefined): boolean {
  return byte !== undefined && ((byte >= 65 && byte <= 90) || (byte >= 97 && byte <= 122));
}

function toLowerByte(byte: number): number {
  return byte >= 65 && byte <= 90 ? byte + 32 : byte;
}

/**
 * Find the byte offset just after the first `<html...>` or `<head...>`
 * opening tag in `buf`. `<html>` is checked first and, when present, always
 * wins: `<head>` is necessarily NESTED inside `<html>` in valid markup, so
 * `<html>`'s closing `>` always appears earlier in the byte stream — using
 * it gives the earliest possible injection point (the script still runs
 * before any of the document's own content either way) without waiting on
 * `<head>`'s own attributes to finish arriving. `<head>` is only the
 * fallback, for the rare document missing an `<html>` tag entirely. Returns
 * -1 if neither tag's closing `>` has been seen yet.
 */
export function findInjectionPoint(buf: Uint8Array): number {
  const html = findTagEnd(buf, 'html');
  if (html >= 0) {
    return html;
  }
  return findTagEnd(buf, 'head');
}

function findTagEnd(buf: Uint8Array, tagName: string): number {
  const needle = `<${tagName}`;
  outer: for (let i = 0; i <= buf.length - needle.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) {
      if (toLowerByte(buf[i + j] ?? 0) !== needle.charCodeAt(j)) {
        continue outer;
      }
    }
    // Matched "<tagName" — require the next byte to end the tag name (not
    // continue it, e.g. reject "<headline" as a match for "<head").
    const after = buf[i + needle.length];
    if (isAsciiLetter(after)) {
      continue;
    }
    for (let k = i + needle.length; k < buf.length; k += 1) {
      if (buf[k] === 0x3e /* '>' */) {
        return k + 1;
      }
    }
    return -1; // tag opened but not yet closed — need more bytes
  }
  return -1;
}

export interface HtmlInjector {
  /** Feed one chunk; returns bytes ready to forward downstream (may be empty while still buffering). */
  push(chunk: Uint8Array): Uint8Array;
  /** No more chunks are coming — flush whatever is still held back, unmodified. */
  flush(): Uint8Array;
}

const EMPTY = new Uint8Array(0);

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.byteLength === 0) return b;
  if (b.byteLength === 0) return a;
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a, 0);
  out.set(b, a.byteLength);
  return out;
}

export function createHtmlInjector(scriptTagBytes: Uint8Array): HtmlInjector {
  let held: Uint8Array = EMPTY;
  let decided = false; // true once injection has happened OR been abandoned

  return {
    push(chunk: Uint8Array): Uint8Array {
      if (decided) {
        return chunk;
      }
      held = concat(held, chunk);
      const point = findInjectionPoint(held);
      if (point >= 0) {
        decided = true;
        const before = held.subarray(0, point);
        const after = held.subarray(point);
        held = EMPTY;
        return concat(concat(before, scriptTagBytes), after);
      }
      if (held.byteLength >= MAX_LOOKAHEAD_BYTES) {
        decided = true;
        const flushed = held;
        held = EMPTY;
        return flushed;
      }
      return EMPTY; // still searching — hold everything back
    },
    flush(): Uint8Array {
      decided = true;
      const flushed = held;
      held = EMPTY;
      return flushed;
    },
  };
}

/** True for content-types the injector should even attempt — never touch non-HTML bodies (JSON, images, JS, CSS, ...). */
export function isInjectableHtml(contentType: string | undefined): boolean {
  if (!contentType) {
    return false;
  }
  return /\btext\/html\b/i.test(contentType);
}
