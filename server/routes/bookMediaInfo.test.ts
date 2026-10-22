import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

import HardcoverAPI from '@server/api/hardcover';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import { User } from '@server/entity/User';
import { Permission } from '@server/lib/permissions';
import type { BookshelfSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import { checkUser, isAuthenticated } from '@server/middleware/auth';
import { setupTestDb } from '@server/test/db';
import type { Express } from 'express';
import express from 'express';
import session from 'express-session';
import request from 'supertest';
import audiobookRoutes from './audiobook';
import authRoutes from './auth';
import ebookRoutes from './ebook';

const OWNER_EMAIL = 'owner@seerr.dev';
const OWNER_PLEX_ID = 918273;

process.env.HARDCOVER_TOKEN ??= 'test-token';

Object.defineProperty(HardcoverAPI.prototype, 'getBookFullDetail', {
  get() {
    return async (id: number) => ({
      id,
      title: 'Test Book',
      slug: 'test-book',
      description: null,
      release_date: null,
      rating: null,
      users_count: 0,
      pages: null,
      image: null,
      cached_tags: null,
      contributions: [
        { author: { id: 7, name: 'Test Author', slug: null, bio: null } },
      ],
      editions: [],
    });
  },
  set() {},
  configurable: true,
});

let app: Express;

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(
    session({
      secret: 'test-secret',
      resave: false,
      saveUninitialized: false,
    })
  );
  app.use(checkUser);
  app.use('/auth', authRoutes);
  app.use('/audiobook', isAuthenticated(), audiobookRoutes);
  app.use('/ebook', isAuthenticated(), ebookRoutes);
  app.use(
    (
      err: { status?: number; message?: string },
      _req: express.Request,
      res: express.Response,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      _next: express.NextFunction
    ) => {
      res
        .status(err.status ?? 500)
        .json({ status: err.status ?? 500, message: err.message });
    }
  );
  return app;
}

before(async () => {
  app = createApp();
});

setupTestDb();

async function loginAs(email: string, password: string) {
  const settings = getSettings();
  const priorLocalLogin = settings.main.localLogin;
  settings.main.localLogin = true;

  try {
    const agent = request.agent(app);
    const res = await agent.post('/auth/local').send({ email, password });
    assert.strictEqual(res.status, 200);
    return agent;
  } finally {
    settings.main.localLogin = priorLocalLogin;
  }
}

async function setViewerPermissions(permissions: number) {
  const userRepository = getRepository(User);
  const viewer = await userRepository.findOneOrFail({
    where: { email: 'friend@seerr.dev' },
  });
  viewer.permissions = permissions;
  await userRepository.save(viewer);
}

function ensureBookshelf(mediaType: BookshelfSettings['mediaType']) {
  const settings = getSettings();
  if (settings.bookshelf.some((s) => s.mediaType === mediaType)) return;
  settings.bookshelf.push({
    id: settings.bookshelf.length,
    name: `test-${mediaType}`,
    hostname: 'bookshelf.invalid',
    port: 8787,
    apiKey: 'test',
    useSsl: false,
    activeProfileId: 1,
    activeProfileName: 'test',
    activeDirectory: '/books',
    activeMetadataProfileId: 1,
    activeMetadataProfileName: 'test',
    tags: [],
    is4k: false,
    isDefault: true,
    syncEnabled: false,
    preventSearch: true,
    tagRequests: false,
    overrideRule: [],
    mediaType,
  });
}

// PENDING so MediaRequestSubscriber never calls Bookshelf
async function seedBookRequest(mediaType: MediaType, tmdbId: number) {
  const userRepository = getRepository(User);
  const owner = await userRepository.findOneOrFail({ where: { id: 1 } });
  owner.email = OWNER_EMAIL;
  owner.plexId = OWNER_PLEX_ID;
  await userRepository.save(owner);

  const media = await getRepository(Media).save(
    new Media({
      mediaType,
      tmdbId,
      status: MediaStatus.PENDING,
      status4k: MediaStatus.UNKNOWN,
    })
  );

  await getRepository(MediaRequest).save(
    new MediaRequest({
      type: mediaType,
      media,
      requestedBy: owner,
      modifiedBy: owner,
      status: MediaRequestStatus.PENDING,
      is4k: false,
    })
  );
}

const routes = [
  {
    path: '/audiobook',
    tmdbId: 4242,
    mediaType: MediaType.AUDIOBOOK,
    bookshelf: 'audiobook' as const,
  },
  {
    path: '/ebook',
    tmdbId: 4343,
    mediaType: MediaType.EBOOK,
    bookshelf: 'ebook' as const,
  },
];

for (const { path, tmdbId, mediaType, bookshelf } of routes) {
  describe(`${path} mediaInfo`, () => {
    it('omits the requesting user’s email and plexId from book detail', async () => {
      await seedBookRequest(mediaType, tmdbId);
      await setViewerPermissions(Permission.REQUEST);
      ensureBookshelf(bookshelf);

      const agent = await loginAs('friend@seerr.dev', 'test1234');
      const res = await agent.get(`${path}/${tmdbId}`);

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.mediaInfo.requests.length, 1);
      assert.strictEqual(res.body.mediaInfo.requests[0].requestedBy.id, 1);

      const serialized = JSON.stringify(res.body);
      assert.ok(!serialized.includes(OWNER_EMAIL), 'email was serialized');
      assert.ok(
        !serialized.includes(String(OWNER_PLEX_ID)),
        'plexId was serialized'
      );
    });

    it('omits another requester’s email and plexId on a duplicate request', async () => {
      await seedBookRequest(mediaType, tmdbId);
      await setViewerPermissions(Permission.REQUEST);
      ensureBookshelf(bookshelf);

      const agent = await loginAs('friend@seerr.dev', 'test1234');
      const res = await agent
        .post(`${path}/request`)
        .send({ foreignBookId: String(tmdbId), authorName: 'Test Author' });

      assert.strictEqual(res.status, 202);
      assert.strictEqual(res.body.request.requestedBy.id, 1);

      const serialized = JSON.stringify(res.body);
      assert.ok(!serialized.includes(OWNER_EMAIL), 'email was serialized');
      assert.ok(
        !serialized.includes(String(OWNER_PLEX_ID)),
        'plexId was serialized'
      );
    });
  });
}
