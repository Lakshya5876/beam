import { describe, expect, it } from 'vitest';
import { forbiddenResponse, isPathAllowed } from '../../src/application/path-authorization.js';

describe('isPathAllowed', () => {
  it('allows everything when the allow-list is empty (default)', () => {
    expect(isPathAllowed([], '/anything/at/all')).toBe(true);
    expect(isPathAllowed([], '/')).toBe(true);
  });

  it('allows an exact match and deeper segments', () => {
    expect(isPathAllowed(['/api'], '/api')).toBe(true);
    expect(isPathAllowed(['/api'], '/api/items')).toBe(true);
    expect(isPathAllowed(['/api'], '/api/items/7')).toBe(true);
  });

  it('uses path-SEGMENT matching, not raw string prefix — /api denies /apifoo', () => {
    expect(isPathAllowed(['/api'], '/apifoo')).toBe(false);
    expect(isPathAllowed(['/api'], '/apiother/x')).toBe(false);
  });

  it('denies paths outside the allow-list', () => {
    expect(isPathAllowed(['/api', '/demo'], '/admin')).toBe(false);
    expect(isPathAllowed(['/api', '/demo'], '/demo/page')).toBe(true);
  });

  it('ignores the query string when matching', () => {
    expect(isPathAllowed(['/api'], '/api/items?page=2')).toBe(true);
    expect(isPathAllowed(['/api'], '/apifoo?x=1')).toBe(false);
  });

  it('normalizes a trailing slash on the allow-list entry', () => {
    expect(isPathAllowed(['/api/'], '/api/items')).toBe(true);
    expect(isPathAllowed(['/api/'], '/apifoo')).toBe(false);
  });
});

describe('forbiddenResponse', () => {
  it('is a 403 with a plain-text body', () => {
    const response = forbiddenResponse();
    expect(response.status).toBe(403);
    expect(new TextDecoder().decode(response.body)).toContain('Forbidden');
  });
});
