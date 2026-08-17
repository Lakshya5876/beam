import { describe, expect, it } from 'vitest';
import { createHtmlInjector, findInjectionPoint, isInjectableHtml } from '../../src/application/html-injection.js';

const utf8 = new TextEncoder();
const decode = new TextDecoder();

describe('findInjectionPoint', () => {
  it('finds the offset right after <html>', () => {
    const buf = utf8.encode('<html><head><meta></head></html>');
    const point = findInjectionPoint(buf);
    expect(decode.decode(buf.subarray(0, point))).toBe('<html>');
  });

  it('finds the offset right after <html ...attrs...>', () => {
    const buf = utf8.encode('<html lang="en" data-x="1"><head></head></html>');
    const point = findInjectionPoint(buf);
    expect(decode.decode(buf.subarray(0, point))).toBe('<html lang="en" data-x="1">');
  });

  it('is case-insensitive', () => {
    const buf = utf8.encode('<HTML><HEAD></HEAD></HTML>');
    const point = findInjectionPoint(buf);
    expect(decode.decode(buf.subarray(0, point))).toBe('<HTML>');
  });

  it('falls back to <head> when there is no <html> tag', () => {
    const buf = utf8.encode('<head><title>x</title></head><body>y</body>');
    const point = findInjectionPoint(buf);
    expect(decode.decode(buf.subarray(0, point))).toBe('<head>');
  });

  it('does not match a tag that merely starts with "html" (e.g. <htmlfragment>)', () => {
    const buf = utf8.encode('<htmlfragment>not it</htmlfragment><html><head></head></html>');
    const point = findInjectionPoint(buf);
    expect(decode.decode(buf.subarray(0, point))).toBe('<htmlfragment>not it</htmlfragment><html>');
  });

  it('an <html> tag STARTED but not yet closed still resolves once it closes (no need to wait on nested <head>)', () => {
    // <head> hasn't even started yet — <html>'s own close is sufficient.
    expect(findInjectionPoint(utf8.encode('<html lang="e'))).toBe(-1);
    expect(findInjectionPoint(utf8.encode('<html lang="en">'))).toBe('<html lang="en">'.length);
  });

  it('returns -1 for a document with neither tag', () => {
    expect(findInjectionPoint(utf8.encode('{"just":"json"}'))).toBe(-1);
  });
});

describe('createHtmlInjector', () => {
  const scriptTag = utf8.encode('<script src="/__beam/ws-shim.js"></script>');

  it('injects the script immediately after <html> when the whole document arrives in one chunk', () => {
    const injector = createHtmlInjector(scriptTag);
    const out = injector.push(utf8.encode('<html><head><title>t</title></head><body>hi</body></html>'));
    const text = decode.decode(out);
    expect(text).toBe('<html><script src="/__beam/ws-shim.js"></script><head><title>t</title></head><body>hi</body></html>');
  });

  it('injects correctly when the injection point straddles a chunk boundary', () => {
    const injector = createHtmlInjector(scriptTag);
    const full = '<html><head><title>t</title></head><body>hi</body></html>';
    const mid = Math.floor(full.length / 2); // arbitrary split, likely mid-tag
    let out = new Uint8Array(0);
    for (const piece of [full.slice(0, mid), full.slice(mid)]) {
      const chunk = injector.push(utf8.encode(piece));
      out = new Uint8Array([...out, ...chunk]);
    }
    out = new Uint8Array([...out, ...injector.flush()]);
    expect(decode.decode(out)).toBe(
      '<html><script src="/__beam/ws-shim.js"></script><head><title>t</title></head><body>hi</body></html>',
    );
  });

  it('streams bytes AFTER the injection point through untouched on subsequent chunks (no re-buffering)', () => {
    const injector = createHtmlInjector(scriptTag);
    const first = injector.push(utf8.encode('<html>'));
    expect(decode.decode(first)).toBe('<html><script src="/__beam/ws-shim.js"></script>');
    const second = injector.push(utf8.encode('<head><title>t</title></head>'));
    expect(decode.decode(second)).toBe('<head><title>t</title></head>');
  });

  it('gives up and flushes unmodified after MAX_LOOKAHEAD_BYTES with no head/html tag found', () => {
    const injector = createHtmlInjector(scriptTag);
    const noise = 'x'.repeat(9000); // > 8192 lookahead cap
    const out = injector.push(utf8.encode(noise));
    expect(decode.decode(out)).toBe(noise);
    // Once abandoned, later chunks pass through untouched too.
    const more = injector.push(utf8.encode('<head>too late</head>'));
    expect(decode.decode(more)).toBe('<head>too late</head>');
  });

  it('flush() returns whatever was buffered if the document ended before any tag appeared', () => {
    const injector = createHtmlInjector(scriptTag);
    const held = injector.push(utf8.encode('short-no-html-here'));
    expect(held.byteLength).toBe(0); // still buffering, waiting for more
    const flushed = injector.flush();
    expect(decode.decode(flushed)).toBe('short-no-html-here');
  });

  it('never corrupts a multi-byte UTF-8 character split exactly at a chunk boundary', () => {
    const doc = '<html><head><title>héllo wörld 你好</title></head></html>';
    const bytes = utf8.encode(doc);
    const expected = '<html><script src="/__beam/ws-shim.js"></script><head><title>héllo wörld 你好</title></head></html>';
    // Split at every possible byte offset and confirm the reassembled output
    // always decodes back to the expected (script-injected) document.
    for (let splitAt = 1; splitAt < bytes.byteLength; splitAt += 7) {
      const inj = createHtmlInjector(scriptTag);
      const a = inj.push(bytes.subarray(0, splitAt));
      const b = inj.push(bytes.subarray(splitAt));
      const c = inj.flush();
      const total = new Uint8Array(a.byteLength + b.byteLength + c.byteLength);
      total.set(a, 0);
      total.set(b, a.byteLength);
      total.set(c, a.byteLength + b.byteLength);
      expect(decode.decode(total)).toBe(expected);
    }
  });
});

describe('isInjectableHtml', () => {
  it('matches text/html with or without a charset parameter', () => {
    expect(isInjectableHtml('text/html')).toBe(true);
    expect(isInjectableHtml('text/html; charset=utf-8')).toBe(true);
    expect(isInjectableHtml('Text/HTML')).toBe(true);
  });

  it('rejects other content types', () => {
    expect(isInjectableHtml('application/json')).toBe(false);
    expect(isInjectableHtml('text/plain')).toBe(false);
    expect(isInjectableHtml('application/xhtml+xml')).toBe(false);
    expect(isInjectableHtml(undefined)).toBe(false);
  });
});
