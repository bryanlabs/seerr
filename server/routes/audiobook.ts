import { getHardcoverClient } from '@server/api/hardcover';
import BookshelfAPI from '@server/api/servarr/bookshelf';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import { Permission } from '@server/lib/permissions';
import type { BookshelfSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { mapHardcoverToBookDetails } from '@server/models/Book';
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
    const mediaRows = await Media.getRelatedMedia(
      req.user!,
      results.map((r) => ({
        tmdbId: Number(r.foreignBookId),
        mediaType: 'audiobook',
      }))
    );
    const enriched = results.map((r) => ({
      ...r,
      mediaInfo: mediaRows.find(
        (m) =>
          m.tmdbId === Number(r.foreignBookId) &&
          m.mediaType === MediaType.AUDIOBOOK
      ),
    }));
    return res.status(200).json({ term, results: enriched });
  } catch (e) {
    logger.error('Audiobook search failed', {
      label: 'API',
      errorMessage: e.message,
      term,
    });
    return next({ status: 500, message: 'Audiobook search failed' });
  }
});

audiobookRoutes.get('/tags', async (req, res) => {
  const client = getHardcoverClient();
  if (!client) return res.status(200).json({ results: [] });
  const cat = Number(req.query.category) || 1;
  const limit = Math.min(Number(req.query.limit) || 40, 100);
  const tags = await client.getTopTags(cat, limit);
  return res.status(200).json({ results: tags });
});

// Best-effort cache to throttle pre-warm calls — we only want to warm a given
// foreignBookId once per process boot. Detail-page path goes Hardcover-direct,
// so we warm the Hardcover detail cache (not Bookshelf).
const warmedBookIds = new Set<number>();
function preWarmHardcover(ids: (number | string | undefined)[]) {
  const client = getHardcoverClient();
  if (!client) return;
  for (const raw of ids) {
    const id = Number(raw);
    if (!Number.isFinite(id) || warmedBookIds.has(id)) continue;
    warmedBookIds.add(id);
    client.getBookFullDetail(id).catch(() => {
      warmedBookIds.delete(id);
    });
  }
}

audiobookRoutes.get('/discover', async (req, res) => {
  const client = getHardcoverClient();
  if (!client) return res.status(200).json({ results: [] });
  const sort = (req.query.sort as string) || 'popularity';
  const dir = (req.query.dir as string) === 'asc' ? 'asc' : 'desc';
  const limit = Math.min(Number(req.query.limit) || 36, 60);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const optStr = (k: string) =>
    typeof req.query[k] === 'string' && req.query[k]
      ? (req.query[k] as string)
      : undefined;
  const optNum = (k: string) => {
    const v = req.query[k];
    if (v == null || v === '') return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  const tagIds =
    typeof req.query.tagIds === 'string' && req.query.tagIds
      ? req.query.tagIds
          .split(',')
          .map((s) => Number(s.trim()))
          .filter((n) => Number.isFinite(n))
      : undefined;
  const books = await client.discover({
    sort: sort as
      | 'popularity'
      | 'title'
      | 'release_date'
      | 'rating'
      | 'trending',
    dir,
    limit,
    offset,
    releaseFrom: optStr('releaseFrom'),
    releaseTo: optStr('releaseTo'),
    pagesMin: optNum('pagesMin'),
    pagesMax: optNum('pagesMax'),
    ratingMin: optNum('ratingMin'),
    ratingMax: optNum('ratingMax'),
    usersCountMin: optNum('usersCountMin'),
    tagIds,
    trendingPeriod:
      (optStr('trendingPeriod') as 'month' | 'quarter' | 'year' | 'all') ??
      'month',
  });
  const mediaRows = await Media.getRelatedMedia(
    req.user!,
    books.map((b) => ({ tmdbId: b.id, mediaType: 'audiobook' }))
  );
  const enriched = books.map((b) => ({
    foreignBookId: String(b.id),
    title: b.title,
    slug: b.slug,
    releaseDate: b.release_date,
    rating: b.rating,
    usersCount: b.users_count,
    pageCount: b.pages,
    overview: b.description,
    remoteCover: b.image?.url,
    authorTitle: b.contributions
      .map((c) => c.author?.name)
      .filter(Boolean)
      .join(', '),
    mediaInfo: mediaRows.find(
      (m) => m.tmdbId === b.id && m.mediaType === MediaType.AUDIOBOOK
    ),
  }));
  // Background pre-warm: trigger Hardcover detail lookups for the
  // discovered books so the user's click on any tile renders instantly.
  preWarmHardcover(enriched.map((b) => b.foreignBookId));
  return res.status(200).json({ sort, dir, results: enriched });
});

audiobookRoutes.get('/profiles', async (_req, res, next) => {
  const server = findAudiobookServer();
  if (!server) {
    return next({
      status: 503,
      message: 'No audiobook Bookshelf server is configured',
    });
  }
  try {
    const client = getClient(server);
    const [profiles, metadataProfiles] = await Promise.all([
      client.getProfiles(),
      client.getMetadataProfiles(),
    ]);
    return res.status(200).json({
      profiles,
      metadataProfiles,
      defaultProfileId: server.activeProfileId,
      defaultMetadataProfileId: server.activeMetadataProfileId,
    });
  } catch (e) {
    return next({
      status: 500,
      message: `Profiles fetch failed: ${e.message}`,
    });
  }
});

audiobookRoutes.post('/request', async (req, res, next) => {
  const { foreignBookId, foreignAuthorId, authorName, profileId } =
    req.body as {
      foreignBookId?: string;
      foreignAuthorId?: string;
      authorName?: string;
      profileId?: number;
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

    const quotas = await req.user.getQuota();
    if (quotas.audiobook.restricted) {
      return next({
        status: 403,
        message: 'Audiobook request quota exceeded',
      });
    }

    const autoApprove = req.user.hasPermission(
      [Permission.AUTO_APPROVE, Permission.MANAGE_REQUESTS],
      { type: 'or' }
    );

    const request = new MediaRequest({
      type: MediaType.AUDIOBOOK,
      media,
      requestedBy: req.user,
      status: autoApprove
        ? MediaRequestStatus.APPROVED
        : MediaRequestStatus.PENDING,
      modifiedBy: autoApprove ? req.user : undefined,
      is4k: false,
      serverId: server.id,
      profileId: profileId ?? server.activeProfileId,
      rootFolder: server.activeDirectory,
      tags: [],
      isAutoRequest: false,
    });

    // MediaRequestSubscriber.afterInsert/afterUpdate will fire sendToBookshelf
    // when status is APPROVED, which performs the Bookshelf addBook and
    // updates Media.status accordingly. Mirrors the Radarr/Sonarr flow.
    await requestRepository.save(request);

    return res.status(201).json({
      request,
      media,
      message: autoApprove
        ? 'Request approved; Bookshelf will pick it up shortly'
        : 'Request pending admin approval',
    });
  } catch (e) {
    logger.error('Audiobook request flow failed', {
      label: 'API',
      errorMessage: e.message,
      foreignBookId,
    });
    return next({ status: 500, message: 'Audiobook request failed' });
  }
});

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
    // Hardcover-first: a single GraphQL call returns title/desc/cover/rating/
    // pages/genres/author/editions in ~100ms. Bookshelf would chain multiple
    // calls and take 5-15s for cold books. We skip Bookshelf in this path and
    // map directly. Bookshelf state (bookshelfId, file count) gets joined
    // when there's a Media row, so that information still appears once the
    // book has actually been requested.
    const hardcover = getHardcoverClient();
    const mediaRepo = getRepository(Media);
    const [detail, media] = await Promise.all([
      hardcover ? hardcover.getBookFullDetail(tmdbId) : Promise.resolve(null),
      mediaRepo.findOne({
        where: { tmdbId, mediaType: MediaType.AUDIOBOOK },
        relations: { requests: true },
      }),
    ]);
    if (!detail) {
      return next({ status: 404, message: 'Book not found' });
    }
    return res
      .status(200)
      .json(
        mapHardcoverToBookDetails(
          detail,
          MediaType.AUDIOBOOK,
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

audiobookRoutes.post('/:foreignBookId/search', async (req, res, next) => {
  const tmdbId = Number(req.params.foreignBookId);
  if (!Number.isFinite(tmdbId)) {
    return next({ status: 400, message: 'foreignBookId must be numeric' });
  }
  const media = await getRepository(Media).findOne({
    where: { tmdbId, mediaType: MediaType.AUDIOBOOK },
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

audiobookRoutes.get('/:foreignBookId/recommendations', async (req, res) => {
  const id = Number(req.params.foreignBookId);
  if (!Number.isFinite(id)) return res.status(200).json({ results: [] });
  const hardcover = getHardcoverClient();
  if (!hardcover) return res.status(200).json({ results: [] });
  const books = await hardcover.getMoreByAuthor(id, 20);
  const results = books.map((b) => ({
    foreignBookId: String(b.id),
    title: b.title,
    slug: b.slug,
    releaseDate: b.release_date,
    rating: b.rating,
    pageCount: b.pages,
    remoteCover: b.image?.url,
    authorTitle: b.contributions
      .map((c) => c.author?.name)
      .filter(Boolean)
      .join(', '),
  }));
  return res.status(200).json({ results });
});

export default audiobookRoutes;
