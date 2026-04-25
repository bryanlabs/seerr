import BookshelfAPI from '@server/api/servarr/bookshelf';
import type { BookshelfSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { Router } from 'express';

/**
 * Phase 1 routes for ebook search + direct add-to-Bookshelf.
 * Mirror of audiobook.ts, pointing at the bookshelf-ebooks instance.
 */
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
  const { foreignBookId, searchNow } = req.body as {
    foreignBookId?: string;
    searchNow?: boolean;
  };

  if (!foreignBookId) {
    return next({ status: 400, message: 'foreignBookId is required' });
  }

  const server = findEbookServer();
  if (!server) {
    return next({
      status: 503,
      message: 'No ebook Bookshelf server is configured',
    });
  }

  try {
    const client = getClient(server);
    const book = await client.addBook({
      foreignBookId,
      profileId: server.activeProfileId,
      metadataProfileId: server.activeMetadataProfileId,
      rootFolderPath: server.activeDirectory,
      monitored: true,
      searchNow: searchNow ?? true,
    });

    return res.status(201).json({
      serverId: server.id,
      book,
    });
  } catch (e) {
    logger.error('Ebook request failed', {
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

export default ebookRoutes;
