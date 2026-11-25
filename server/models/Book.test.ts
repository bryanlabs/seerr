import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  guessAuthorCandidates,
  pickHardcoverAuthor,
} from '@server/models/Book';

describe('pickHardcoverAuthor', () => {
  const candidates = guessAuthorCandidates(
    'dinniman, matt Dungeon Crawler Carl',
    'Dungeon Crawler Carl'
  );

  it('prefers the contribution matching the Bookshelf author', () => {
    assert.deepEqual(
      pickHardcoverAuthor(
        [
          { author: { id: 1, name: 'Jeff Hays' } },
          { author: { id: 2, name: 'Matt Dinniman' } },
        ],
        candidates
      ),
      { id: 2, name: 'Matt Dinniman' }
    );
  });

  it('falls back to the first author with an id', () => {
    assert.deepEqual(
      pickHardcoverAuthor(
        [{ author: null }, { author: { id: 7, name: 'M. Dinniman' } }],
        candidates
      ),
      { id: 7, name: 'M. Dinniman' }
    );
  });

  it('returns nothing without contributions', () => {
    assert.equal(pickHardcoverAuthor(undefined, candidates), undefined);
    assert.equal(pickHardcoverAuthor([], candidates), undefined);
  });
});
