import { ObjectMissingError } from '@sotto/storage';
import { describe, expect, it } from 'vitest';
import { ApiException, describeError } from '../src/common/errors.js';

describe('describeError', () => {
  it('reports storage that can’t be reached or signed for as 503 STORAGE_UNAVAILABLE', () => {
    // What every upload hit on the demo when its containers had no AWS credentials (ADR 0018).
    const noCredentials = Object.assign(
      new Error('Could not load credentials from any providers'),
      { name: 'CredentialsProviderError' },
    );
    const refused = Object.assign(new Error('connect ECONNREFUSED'), {
      code: 'ECONNREFUSED',
      $metadata: { attempts: 3 },
    });
    for (const error of [noCredentials, refused]) {
      const described = describeError(error);
      expect(described).toMatchObject({ status: 503, code: 'STORAGE_UNAVAILABLE' });
      expect(described.message).toMatch(/can’t reach file storage/);
      // Written for people: never the SDK's own words, which can carry URLs and keys.
      expect(described.message).not.toMatch(/credentials|ECONNREFUSED/);
    }
  });

  it('leaves the api’s own errors and unknown failures as they were', () => {
    expect(describeError(new ApiException(415, 'UNSUPPORTED_TYPE', 'Nope.'))).toEqual({
      status: 415,
      code: 'UNSUPPORTED_TYPE',
      message: 'Nope.',
    });
    expect(describeError(new ObjectMissingError('files/w/f/original.pdf'))).toMatchObject({
      status: 500,
      code: 'INTERNAL',
    });
    expect(describeError(new Error('boom'))).toMatchObject({ status: 500, code: 'INTERNAL' });
  });
});
