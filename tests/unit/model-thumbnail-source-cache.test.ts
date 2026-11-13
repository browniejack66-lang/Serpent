import { describe, expect, it } from 'vitest';

import {
  clearLibraryModelThumbnailSourceAuthorizations,
  clearModelThumbnailSourceAuthorizations,
  registerModelThumbnailSourceAuthorizations,
  resolveModelThumbnailSourceAuthorization,
} from '../../src/main/model-thumbnail-source-cache';

describe('model thumbnail source authorization cache', () => {
  it('revokes every source of a relocked library without revoking other libraries', () => {
    const sources = [
      { libraryId: 'library-1', assetId: 'asset-1', revisionId: 'r1', absolutePath: '/fixture/one.obj', mimeType: 'model/obj' },
      { libraryId: 'library-1', assetId: 'asset-2', revisionId: 'r2', absolutePath: '/fixture/two.obj', mimeType: 'model/obj' },
      { libraryId: 'library-2', assetId: 'asset-3', revisionId: 'r3', absolutePath: '/fixture/three.obj', mimeType: 'model/obj' },
    ];
    registerModelThumbnailSourceAuthorizations(sources);
    try {
      clearLibraryModelThumbnailSourceAuthorizations('library-1');
      expect(resolveModelThumbnailSourceAuthorization(sources[0]!)).toBeUndefined();
      expect(resolveModelThumbnailSourceAuthorization(sources[1]!)).toBeUndefined();
      expect(resolveModelThumbnailSourceAuthorization(sources[2]!)).toEqual(sources[2]);
    } finally {
      clearModelThumbnailSourceAuthorizations(sources);
    }
  });
  it('serves only the Worker-authorized revision tuple and clears it after render', () => {
    const authorization = {
      libraryId: 'library-1',
      assetId: 'asset-1',
      revisionId: 'revision-1',
      absolutePath: '/private/library/asset.obj',
      mimeType: 'model/obj',
    };

    registerModelThumbnailSourceAuthorizations([authorization]);
    expect(resolveModelThumbnailSourceAuthorization(authorization)).toEqual(authorization);
    expect(
      resolveModelThumbnailSourceAuthorization({
        ...authorization,
        revisionId: 'stale-revision',
      }),
    ).toBeUndefined();

    clearModelThumbnailSourceAuthorizations([authorization]);
    expect(resolveModelThumbnailSourceAuthorization(authorization)).toBeUndefined();
  });
});
