import BookshelfAPI from '@server/api/servarr/bookshelf';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import type { BookshelfSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { guessAuthorName, mapBookDetails } from '@server/models/Book';
import { Router } from 'express';

/**
 * Phase 1+ routes for audiobook search + request.
 *
 * Search returns Bookshelf /book/lookup results.
 *
 * Request creates Media + MediaRequest rows so the entry shows in Seerr's
 * request log, then calls Bookshelf to actually add the book and trigger an
 * indexer search. Admin/auto-approve users land an APPROVED request directly;
 * everyone else gets PENDING (Phase 2 will add an admin approval UI for
 * audiobooks/ebooks). On success Media.status moves to PROCESSING.
 */
const audiobookRoutes = Router();

function findAudiobookServer(): BookshelfSettings | undefined {
  const servers = getSettings().bookshelf.filter(
    (s) => s.mediaType === 'audiobook'
  );
  return servers.find((s) => s.isDefault) ?? servers[0];
}

function getClient(server: BookshelfSettings): BookshelfAPI {
  return new BookshelfAPI({
    apiKey: server.apiKey,
    url: BookshelfAPI.buildUrl(server, '/api/v1'),
  });
}

audiobookRoutes.get('/search', async (req, res, next) => {
  const term = typeof req.query.q === 'string' ? req.query.q : '';
  if (!term) {
    return next({ status: 400, message: 'Missing q parameter' });
  }

  const server = findAudiobookServer();
  if (!server) {
    return next({
      status: 503,
      message: 'No audiobook Bookshelf server is configured',
    });
  }

  try {
    const results = await getClient(server).searchBook(term);
    return res.status(200).json({ term, results });
  } catch (e) {
    logger.error('Audiobook search failed', {
      label: 'API',
      errorMessage: e.message,
      term,
    });
    return next({ status: 500, message: 'Audiobook search failed' });
  }
});

audiobookRoutes.post('/request', async (req, res, next) => {
  const { foreignBookId, foreignAuthorId, authorName, title, searchNow } =
    req.body as {
      foreignBookId?: string;
      foreignAuthorId?: string;
      authorName?: string;
      title?: string;
      searchNow?: boolean;
    };

  if (!foreignBookId) {
    return next({ status: 400, message: 'foreignBookId is required' });
  }
  if (!foreignAuthorId && !authorName) {
    return next({
      status: 400,
      message: 'foreignAuthorId or authorName is required',
    });
  }
  if (!req.user) {
    return next({ status: 401, message: 'Authentication required' });
  }

  const server = findAudiobookServer();
  if (!server) {
    return next({
      status: 503,
      message: 'No audiobook Bookshelf server is configured',
    });
  }

  const tmdbId = Number(foreignBookId);
  if (!Number.isFinite(tmdbId)) {
    return next({
      status: 400,
      message: 'foreignBookId must be a numeric Hardcover work id',
    });
  }

  const mediaRepository = getRepository(Media);
  const requestRepository = getRepository(MediaRequest);

  try {
    let media = await mediaRepository.findOne({
      where: { tmdbId, mediaType: MediaType.AUDIOBOOK },
      relations: ['requests'],
    });
    if (!media) {
      media = new Media({
        tmdbId,
        mediaType: MediaType.AUDIOBOOK,
        status: MediaStatus.PENDING,
      });
    } else if (media.status === MediaStatus.BLOCKLISTED) {
      return next({ status: 403, message: 'This book is blocklisted' });
    }
    await mediaRepository.save(media);

    // Don't create a duplicate request if one is already in flight
    const existing = (media.requests ?? []).find(
      (r) =>
        r.status === MediaRequestStatus.PENDING ||
        r.status === MediaRequestStatus.APPROVED
    );
    if (existing) {
      return res.status(202).json({
        message: 'Request already exists',
        request: existing,
        media,
      });
    }

    const request = new MediaRequest({
      type: MediaType.AUDIOBOOK,
      media,
      requestedBy: req.user,
      status: MediaRequestStatus.APPROVED,
      modifiedBy: req.user,
      is4k: false,
      serverId: server.id,
      profileId: server.activeProfileId,
      rootFolder: server.activeDirectory,
      tags: [],
      isAutoRequest: false,
    });
    await requestRepository.save(request);

    try {
      const book = await getClient(server).addBook({
        foreignBookId,
        foreignAuthorId,
        authorName,
        profileId: server.activeProfileId,
        metadataProfileId: server.activeMetadataProfileId,
        rootFolderPath: server.activeDirectory,
        monitored: true,
        searchNow: searchNow ?? true,
      });

      // Use a targeted update rather than save(): saving the parent Media
      // entity here triggers cascade on the OneToMany requests relation,
      // which in turn can null out the FK on the request row we just
      // inserted.
      await mediaRepository.update(media.id, {
        status: MediaStatus.PROCESSING,
        serviceId: server.id,
        externalServiceId: book.id ?? null,
        externalServiceSlug: book.titleSlug ?? null,
      });

      logger.info('Audiobook request submitted', {
        label: 'API',
        bookId: book.id,
        title: book.title,
        requestedBy: req.user.id,
      });

      return res.status(201).json({ request, media, book });
    } catch (e) {
      // Mark the request as failed but keep the row so it shows in the log
      request.status = MediaRequestStatus.FAILED;
      await requestRepository.save(request);
      logger.error('Audiobook addBook failed; request marked FAILED', {
        label: 'API',
        errorMessage: e.message,
        foreignBookId,
        title,
      });
      return next({
        status: 500,
        message: `Audiobook request failed: ${e.message}`,
      });
    }
  } catch (e) {
    logger.error('Audiobook request flow failed', {
      label: 'API',
      errorMessage: e.message,
      foreignBookId,
    });
    return next({ status: 500, message: 'Audiobook request failed' });
  }
});

audiobookRoutes.get('/info/:foreignBookId', async (req, res, next) => {
  const server = findAudiobookServer();
  if (!server) {
    return next({
      status: 503,
      message: 'No audiobook Bookshelf server is configured',
    });
  }
  try {
    const results = await getClient(server).searchBook(
      `work:${req.params.foreignBookId}`
    );
    const match = results[0];
    if (!match) {
      return next({ status: 404, message: 'Book not found' });
    }
    return res.status(200).json(match);
  } catch (e) {
    return next({
      status: 500,
      message: `Audiobook info failed: ${e.message}`,
    });
  }
});

audiobookRoutes.get('/:foreignBookId', async (req, res, next) => {
  const server = findAudiobookServer();
  if (!server) {
    return next({
      status: 503,
      message: 'No audiobook Bookshelf server is configured',
    });
  }
  const tmdbId = Number(req.params.foreignBookId);
  if (!Number.isFinite(tmdbId)) {
    return next({ status: 400, message: 'foreignBookId must be numeric' });
  }
  try {
    const client = getClient(server);
    const results = await client.searchBook(`work:${req.params.foreignBookId}`);
    const match = results[0];
    if (!match) {
      return next({ status: 404, message: 'Book not found' });
    }
    const guessedName = guessAuthorName(match.authorTitle, match.title);
    let resolvedAuthor;
    if (guessedName) {
      const lookup = await client.searchAuthor(guessedName).catch(() => []);
      resolvedAuthor = lookup[0];
    }
    const media = await getRepository(Media).findOne({
      where: { tmdbId, mediaType: MediaType.AUDIOBOOK },
      relations: { requests: true },
    });
    return res
      .status(200)
      .json(
        mapBookDetails(
          match,
          MediaType.AUDIOBOOK,
          resolvedAuthor,
          media ?? undefined
        )
      );
  } catch (e) {
    logger.error('Audiobook details failed', {
      label: 'API',
      errorMessage: e.message,
      foreignBookId: req.params.foreignBookId,
    });
    return next({
      status: 500,
      message: `Audiobook details failed: ${e.message}`,
    });
  }
});

audiobookRoutes.get(
  '/:foreignBookId/recommendations',
  async (req, res, next) => {
    const server = findAudiobookServer();
    if (!server) {
      return next({
        status: 503,
        message: 'No audiobook Bookshelf server is configured',
      });
    }
    try {
      const client = getClient(server);
      const baseLookup = await client.searchBook(
        `work:${req.params.foreignBookId}`
      );
      const base = baseLookup[0];
      if (!base) {
        return res.status(200).json({ results: [] });
      }
      const authorName = guessAuthorName(base.authorTitle, base.title);
      if (!authorName) {
        return res.status(200).json({ results: [] });
      }
      const moreByAuthor = await client.searchBook(authorName).catch(() => []);
      const filtered = moreByAuthor
        .filter((b) => b.foreignBookId !== base.foreignBookId)
        .slice(0, 20);
      return res.status(200).json({ results: filtered });
    } catch (e) {
      return next({
        status: 500,
        message: `Audiobook recommendations failed: ${e.message}`,
      });
    }
  }
);

audiobookRoutes.get('/queue', async (req, res, next) => {
  const server = findAudiobookServer();
  if (!server) {
    return next({
      status: 503,
      message: 'No audiobook Bookshelf server is configured',
    });
  }
  try {
    const queue = await getClient(server).getQueue();
    return res.status(200).json({ serverId: server.id, queue });
  } catch {
    return next({ status: 500, message: 'Failed to retrieve audiobook queue' });
  }
});

export default audiobookRoutes;
