import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isRealImage, matchAlbum } from '@server/lib/bookPlexArt';

describe('book Plex art', () => {
  const albums = [
    {
      ratingKey: '1',
      title: '02 Spook Country',
      parentTitle: 'William Gibson (Blue Ant)',
    },
    { ratingKey: '2', title: 'Ready Player Two', parentTitle: 'Ernest Cline' },
    { ratingKey: '3', title: 'Ready Player One', parentTitle: 'Ernest Cline' },
  ];

  it('matches series-numbered albums and subtitles by title and surname', () => {
    assert.strictEqual(
      matchAlbum(albums, 'Spook Country', 'William Gibson')?.ratingKey,
      '1'
    );
    assert.strictEqual(
      matchAlbum(albums, 'Ready Player Two: A Novel', 'Ernest Cline')
        ?.ratingKey,
      '2'
    );
  });

  it('does not match a different author or a sequel by prefix', () => {
    assert.strictEqual(
      matchAlbum(albums, 'Spook Country', 'Someone Else'),
      undefined
    );
    assert.strictEqual(
      matchAlbum(albums, 'Ready Player', 'Ernest Cline'),
      undefined
    );
  });

  it('accepts only real JPEG or PNG images of at least 8 KB', () => {
    const jpeg = Buffer.alloc(9000);
    jpeg[0] = 0xff;
    jpeg[1] = 0xd8;
    assert.ok(isRealImage(jpeg));
    const placeholder = Buffer.alloc(2302);
    placeholder.set([0x89, 0x50, 0x4e, 0x47]);
    assert.ok(!isRealImage(placeholder));
    assert.ok(!isRealImage(Buffer.alloc(9000)));
  });
});
