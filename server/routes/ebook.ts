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

/** Mirror of audiobook.ts for the ebook Bookshelf instance. */
const ebookRoutes = Router();

function findEbookServer(): BookshelfSettings | undefined {
  const servers = getSettings().bookshelf.filter(
    (s) => s.mediaType === 'ebook'
  );
  return servers.find((s) => s.isDefault) ?? servers[0];
}

function getClient(server: BookshelfSettings): BookshelfAPI {
  return new BookshelfAPI({
    apiKey: server.apiKey,
    url: BookshelfAPI.buildUrl(server, '/api/v1'),
  });
}

ebookRoutes.get('/search', async (req, res, next) => {
  const term = typeof req.query.q === 'string' ? req.query.q : '';
  if (!term) {
    return next({ status: 400, message: 'Missing q parameter' });
  }

  const server = findEbookServer();
  if (!server) {
    return next({
      status: 503,
      message: 'No ebook Bookshelf server is configured',
    });
  }

  try {
    const results = await getClient(server).searchBook(term);
    return res.status(200).json({ term, results });
  } catch (e) {
    logger.error('Ebook search failed', {
      label: 'API',
      errorMessage: e.message,
      term,
    });
    return next({ status: 500, message: 'Ebook search failed' });
  }
});

ebookRoutes.post('/request', async (req, res, next) => {
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

  const server = findEbookServer();
  if (!server) {
    return next({
      status: 503,
      message: 'No ebook Bookshelf server is configured',
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
      where: { tmdbId, mediaType: MediaType.EBOOK },
      relations: ['requests'],
    });
    if (!media) {
      media = new Media({
        tmdbId,
        mediaType: MediaType.EBOOK,
        status: MediaStatus.PENDING,
      });
    } else if (media.status === MediaStatus.BLOCKLISTED) {
      return next({ status: 403, message: 'This book is blocklisted' });
    }
    await mediaRepository.save(media);

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
      type: MediaType.EBOOK,
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

      // Targeted update to avoid the OneToMany cascade nulling the FK on
      // the request row we just inserted (see audiobook.ts comment).
      await mediaRepository.update(media.id, {
        status: MediaStatus.PROCESSING,
        serviceId: server.id,
        externalServiceId: book.id ?? null,
        externalServiceSlug: book.titleSlug ?? null,
      });

      logger.info('Ebook request submitted', {
        label: 'API',
        bookId: book.id,
        title: book.title,
        requestedBy: req.user.id,
      });

      return res.status(201).json({ request, media, book });
    } catch (e) {
      request.status = MediaRequestStatus.FAILED;
      await requestRepository.save(request);
      logger.error('Ebook addBook failed; request marked FAILED', {
        label: 'API',
        errorMessage: e.message,
        foreignBookId,
        title,
      });
      return next({
        status: 500,
        message: `Ebook request failed: ${e.message}`,
      });
    }
  } catch (e) {
    logger.error('Ebook request flow failed', {
      label: 'API',
      errorMessage: e.message,
      foreignBookId,
    });
    return next({ status: 500, message: 'Ebook request failed' });
  }
});

ebookRoutes.get('/queue', async (req, res, next) => {
  const server = findEbookServer();
  if (!server) {
    return next({
      status: 503,
      message: 'No ebook Bookshelf server is configured',
    });
  }
  try {
    const queue = await getClient(server).getQueue();
    return res.status(200).json({ serverId: server.id, queue });
  } catch {
    return next({ status: 500, message: 'Failed to retrieve ebook queue' });
  }
});

ebookRoutes.get('/info/:foreignBookId', async (req, res, next) => {
  const server = findEbookServer();
  if (!server) {
    return next({
      status: 503,
      message: 'No ebook Bookshelf server is configured',
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
      message: `Ebook info failed: ${e.message}`,
    });
  }
});

ebookRoutes.get('/:foreignBookId', async (req, res, next) => {
  const server = findEbookServer();
  if (!server) {
    return next({
      status: 503,
      message: 'No ebook Bookshelf server is configured',
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
      where: { tmdbId, mediaType: MediaType.EBOOK },
      relations: { requests: true },
    });
    return res
      .status(200)
      .json(
        mapBookDetails(
          match,
          MediaType.EBOOK,
          resolvedAuthor,
          media ?? undefined
        )
      );
  } catch (e) {
    logger.error('Ebook details failed', {
      label: 'API',
      errorMessage: e.message,
      foreignBookId: req.params.foreignBookId,
    });
    return next({
      status: 500,
      message: `Ebook details failed: ${e.message}`,
    });
  }
});

ebookRoutes.post('/:foreignBookId/search', async (req, res, next) => {
  const tmdbId = Number(req.params.foreignBookId);
  if (!Number.isFinite(tmdbId)) {
    return next({ status: 400, message: 'foreignBookId must be numeric' });
  }
  const media = await getRepository(Media).findOne({
    where: { tmdbId, mediaType: MediaType.EBOOK },
  });
  if (!media || media.serviceId == null || media.externalServiceId == null) {
    return next({
      status: 404,
      message: 'Book not yet added to Bookshelf',
    });
  }
  const server = getSettings().bookshelf.find((b) => b.id === media.serviceId);
  if (!server) {
    return next({
      status: 404,
      message: 'Bookshelf instance not found',
    });
  }
  try {
    const client = getClient(server);
    await client.searchBookCommand(media.externalServiceId);
    return res.status(202).json({ message: 'BookSearch queued' });
  } catch (e) {
    return next({
      status: 500,
      message: `Force search failed: ${e.message}`,
    });
  }
});

ebookRoutes.get('/:foreignBookId/recommendations', async (req, res, next) => {
  const server = findEbookServer();
  if (!server) {
    return next({
      status: 503,
      message: 'No ebook Bookshelf server is configured',
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
      message: `Ebook recommendations failed: ${e.message}`,
    });
  }
});

export default ebookRoutes;
