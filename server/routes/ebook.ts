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
import {
  mapHardcoverToBookDetails,
  mapHardcoverToBookSearchResult,
} from '@server/models/Book';
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

  try {
    const hardcover = getHardcoverClient();
    const results = hardcover
      ? (
          await hardcover.searchBooks(term, {
            mediaType: 'ebook',
            limit: 30,
          })
        ).map(mapHardcoverToBookSearchResult)
      : await (async () => {
          const server = findEbookServer();
          if (!server) {
            throw new Error('No ebook Bookshelf server is configured');
          }
          return getClient(server).searchBook(term);
        })();
    const mediaRows = await Media.getRelatedMedia(
      req.user!,
      results.map((r) => ({
        tmdbId: Number(r.foreignBookId),
        mediaType: 'ebook',
      }))
    );
    const enriched = results.map((r) => ({
      ...r,
      mediaInfo: mediaRows.find(
        (m) =>
          m.tmdbId === Number(r.foreignBookId) &&
          m.mediaType === MediaType.EBOOK
      ),
    }));
    return res.status(200).json({ term, results: enriched });
  } catch (e) {
    logger.error('Ebook search failed', {
      label: 'API',
      errorMessage: e.message,
      term,
    });
    return next({ status: 500, message: 'Ebook search failed' });
  }
});

ebookRoutes.get('/tags', async (req, res) => {
  const client = getHardcoverClient();
  if (!client) return res.status(200).json({ results: [] });
  const cat = Number(req.query.category) || 1;
  const limit = Math.min(Number(req.query.limit) || 40, 100);
  const tags = await client.getTopTags(cat, limit);
  return res.status(200).json({ results: tags });
});

// Best-effort cache to throttle pre-warm calls — same as audiobook side; the
// Hardcover cache is the only one we need to warm now that detail pages go
// Hardcover-direct.
const warmedEbookIds = new Set<number>();
function preWarmHardcover(ids: (number | string | undefined)[]) {
  const client = getHardcoverClient();
  if (!client) return;
  for (const raw of ids) {
    const id = Number(raw);
    if (!Number.isFinite(id) || warmedEbookIds.has(id)) continue;
    warmedEbookIds.add(id);
    client.getBookFullDetail(id).catch(() => {
      warmedEbookIds.delete(id);
    });
  }
}

ebookRoutes.get('/discover', async (req, res) => {
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
    books.map((b) => ({ tmdbId: b.id, mediaType: 'ebook' }))
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
      (m) => m.tmdbId === b.id && m.mediaType === MediaType.EBOOK
    ),
  }));
  preWarmHardcover(enriched.map((b) => b.foreignBookId));
  return res.status(200).json({ sort, dir, results: enriched });
});

ebookRoutes.get('/profiles', async (_req, res, next) => {
  const server = findEbookServer();
  if (!server) {
    return next({
      status: 503,
      message: 'No ebook Bookshelf server is configured',
    });
  }
  try {
    const client = getClient(server);
    const [profiles, metadataProfiles, rootFolders, tags] = await Promise.all([
      client.getProfiles(),
      client.getMetadataProfiles(),
      client.getRootFolders(),
      client.getTags(),
    ]);
    const servers = await Promise.all(
      getSettings()
        .bookshelf.filter((s) => s.mediaType === 'ebook')
        .map(async (s) => {
          const sClient = getClient(s);
          const [sProfiles, sMetadataProfiles, sRootFolders, sTags] =
            await Promise.all([
              sClient.getProfiles().catch(() => []),
              sClient.getMetadataProfiles().catch(() => []),
              sClient.getRootFolders().catch(() => []),
              sClient.getTags().catch(() => []),
            ]);
          return {
            id: s.id,
            name: s.name,
            isDefault: s.isDefault,
            activeProfileId: s.activeProfileId,
            activeMetadataProfileId: s.activeMetadataProfileId,
            activeDirectory: s.activeDirectory,
            activeTags: s.tags ?? [],
            profiles: sProfiles,
            metadataProfiles: sMetadataProfiles,
            rootFolders: sRootFolders,
            tags: sTags,
          };
        })
    );
    return res.status(200).json({
      profiles,
      metadataProfiles,
      rootFolders,
      tags,
      servers,
      defaultServerId: server.id,
      defaultProfileId: server.activeProfileId,
      defaultMetadataProfileId: server.activeMetadataProfileId,
      defaultRootFolder: server.activeDirectory,
      defaultTags: server.tags ?? [],
    });
  } catch (e) {
    return next({
      status: 500,
      message: `Profiles fetch failed: ${e.message}`,
    });
  }
});

ebookRoutes.post('/request', async (req, res, next) => {
  const {
    foreignBookId,
    foreignAuthorId,
    authorName,
    profileId,
    metadataProfileId,
    serverId,
    rootFolder,
    tags,
  } = req.body as {
    foreignBookId?: string;
    foreignAuthorId?: string;
    authorName?: string;
    profileId?: number;
    metadataProfileId?: number;
    serverId?: number;
    rootFolder?: string;
    tags?: number[];
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

  const server =
    getSettings().bookshelf.find(
      (s) => s.mediaType === 'ebook' && s.id === serverId
    ) ?? findEbookServer();
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

    const quotas = await req.user.getQuota();
    if (quotas.ebook.restricted) {
      return next({
        status: 403,
        message: 'Ebook request quota exceeded',
      });
    }

    const autoApprove = req.user.hasPermission(
      [Permission.AUTO_APPROVE, Permission.MANAGE_REQUESTS],
      { type: 'or' }
    );

    const request = new MediaRequest({
      type: MediaType.EBOOK,
      media,
      requestedBy: req.user,
      status: autoApprove
        ? MediaRequestStatus.APPROVED
        : MediaRequestStatus.PENDING,
      modifiedBy: autoApprove ? req.user : undefined,
      is4k: false,
      serverId: server.id,
      profileId: profileId ?? server.activeProfileId,
      languageProfileId: metadataProfileId ?? server.activeMetadataProfileId,
      rootFolder: rootFolder ?? server.activeDirectory,
      tags: tags ?? [],
      isAutoRequest: false,
    });

    // sendToBookshelf in MediaRequestSubscriber handles the Bookshelf addBook
    // when status is APPROVED.
    await requestRepository.save(request);

    return res.status(201).json({
      request,
      media,
      message: autoApprove
        ? 'Request approved; Bookshelf will pick it up shortly'
        : 'Request pending admin approval',
    });
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
  const tmdbId = Number(req.params.foreignBookId);
  const hardcover = Number.isFinite(tmdbId) ? getHardcoverClient() : null;
  if (hardcover) {
    const detail = await hardcover.getBookFullDetail(tmdbId);
    if (detail) {
      return res.status(200).json({
        foreignBookId: String(detail.id),
        title: detail.title,
        slug: detail.slug ?? undefined,
        releaseDate: detail.release_date ?? undefined,
        rating: detail.rating ?? undefined,
        pageCount: detail.pages ?? undefined,
        remoteCover: detail.image?.url,
        authorTitle: detail.contributions
          .map((c) => c.author?.name)
          .filter(Boolean)
          .join(', '),
      });
    }
  }
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
    // Hardcover-first: see audiobook.ts for the rationale. Single ~100ms
    // Hardcover call replaces 5-15s of chained Bookshelf lookups.
    const hardcover = getHardcoverClient();
    const mediaRepo = getRepository(Media);
    const [detail, media] = await Promise.all([
      hardcover ? hardcover.getBookFullDetail(tmdbId) : Promise.resolve(null),
      mediaRepo.findOne({
        where: { tmdbId, mediaType: MediaType.EBOOK },
        relations: { requests: true },
      }),
    ]);
    if (!detail) {
      return next({ status: 404, message: 'Book not found' });
    }
    return res
      .status(200)
      .json(
        mapHardcoverToBookDetails(detail, MediaType.EBOOK, media ?? undefined)
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

ebookRoutes.get('/:foreignBookId/recommendations', async (req, res) => {
  const id = Number(req.params.foreignBookId);
  if (!Number.isFinite(id)) return res.status(200).json({ results: [] });
  const hardcover = getHardcoverClient();
  if (!hardcover) return res.status(200).json({ results: [] });
  const [moreByAuthor, trending] = await Promise.all([
    hardcover.getMoreByAuthor(id, 20),
    hardcover.getTrending('month', 20),
  ]);
  const allBooks = [...moreByAuthor, ...trending];
  const mediaRows = await Media.getRelatedMedia(
    req.user!,
    allBooks.map((b) => ({ tmdbId: b.id, mediaType: 'ebook' }))
  );
  const toResult = (b: (typeof allBooks)[number]) => ({
    foreignBookId: String(b.id),
    title: b.title,
    slug: b.slug,
    releaseDate: b.release_date,
    rating: b.rating,
    pageCount: b.pages,
    overview: b.description,
    remoteCover: b.image?.url,
    authorTitle: b.contributions
      .map((c) => c.author?.name)
      .filter(Boolean)
      .join(', '),
    mediaInfo: mediaRows.find(
      (m) => m.tmdbId === b.id && m.mediaType === MediaType.EBOOK
    ),
  });
  const sections = [
    {
      key: 'author',
      title: 'More by this author',
      results: moreByAuthor.map(toResult),
    },
    {
      key: 'trending',
      title: 'Trending ebooks',
      results: trending.filter((b) => b.id !== id).map(toResult),
    },
  ].filter((s) => s.results.length > 0);
  return res
    .status(200)
    .json({ results: sections[0]?.results ?? [], sections });
});

export default ebookRoutes;
