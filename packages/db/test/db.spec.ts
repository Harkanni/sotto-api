import { describe, expect, it } from 'vitest';
import { redactDatabaseUrl } from '../src/index.js';

describe('redactDatabaseUrl', () => {
  it('hides the password', () => {
    expect(redactDatabaseUrl('postgresql://sotto:s3cret@db:5432/sotto')).toBe(
      'postgresql://sotto:***@db:5432/sotto',
    );
  });

  it('never throws on junk', () => {
    expect(redactDatabaseUrl('not a url')).toBe('<invalid url>');
  });
});
