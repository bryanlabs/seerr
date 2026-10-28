import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

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
import { MediaRequestSubscriber } from '@server/subscriber/MediaRequestSubscriber';
import { setupTestDb } from '@server/test/db';
import type { Express } from 'express';
import express from 'express';
import session from 'express-session';
import request from 'supertest';
import audiobookRoutes from './audiobook';
import authRoutes from './auth';
import ebookRoutes from './ebook';

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

// One book request against a limit of one leaves the friend at quota
async function exhaustFriendQuota(mediaType: MediaType, tmdbId: number) {
  const userRepository = getRepository(User);
  const friend = await userRepository.findOneOrFail({
    where: { email: 'friend@seerr.dev' },
  });
  friend.permissions = Permission.REQUEST;
  if (mediaType === MediaType.AUDIOBOOK) {
    friend.audiobookQuotaLimit = 1;
    friend.audiobookQuotaDays = 7;
  } else {
    friend.ebookQuotaLimit = 1;
    friend.ebookQuotaDays = 7;
  }
  await userRepository.save(friend);

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
      requestedBy: friend,
      status: MediaRequestStatus.PENDING,
      is4k: false,
    })
  );
  return friend;
}

const routes = [
  {
    path: '/audiobook',
    tmdbId: 5252,
    mediaType: MediaType.AUDIOBOOK,
    bookshelf: 'audiobook' as const,
  },
  {
    path: '/ebook',
    tmdbId: 5353,
    mediaType: MediaType.EBOOK,
    bookshelf: 'ebook' as const,
  },
];

for (const { path, tmdbId, mediaType, bookshelf } of routes) {
  describe(`POST ${path}/request`, () => {
    it('lets an admin file a request for a user past quota with ignoreQuota', async (t) => {
      ensureBookshelf(bookshelf);
      const friend = await exhaustFriendQuota(mediaType, tmdbId + 1);
      const sendToBookshelf = t.mock.method(
        MediaRequestSubscriber.prototype,
        'sendToBookshelf',
        async () => undefined
      );
      const admin = await loginAs('admin@seerr.dev', 'test1234');

      const blocked = await admin.post(`${path}/request`).send({
        foreignBookId: String(tmdbId),
        authorName: 'Test Author',
        userId: friend.id,
      });
      assert.strictEqual(blocked.status, 403);

      const res = await admin.post(`${path}/request`).send({
        foreignBookId: String(tmdbId),
        authorName: 'Test Author',
        userId: friend.id,
        ignoreQuota: true,
      });
      assert.strictEqual(res.status, 201);

      const saved = await getRepository(MediaRequest).findOneOrFail({
        where: { id: res.body.request.id },
        relations: { requestedBy: true, modifiedBy: true },
      });
      assert.strictEqual(saved.requestedBy.id, friend.id);
      assert.strictEqual(saved.modifiedBy?.id, 1);
      assert.strictEqual(saved.ignoreQuota, true);
      assert.strictEqual(saved.status, MediaRequestStatus.APPROVED);
      assert.strictEqual(sendToBookshelf.mock.callCount(), 1);

      const quota = await friend.getQuota();
      const used =
        mediaType === MediaType.AUDIOBOOK
          ? quota.audiobook.used
          : quota.ebook.used;
      assert.strictEqual(used, 1, 'bypassed request was counted toward quota');
    });

    it('rejects ignoreQuota from a user without manage requests', async () => {
      ensureBookshelf(bookshelf);
      await exhaustFriendQuota(mediaType, tmdbId + 1);
      const agent = await loginAs('friend@seerr.dev', 'test1234');

      const res = await agent.post(`${path}/request`).send({
        foreignBookId: String(tmdbId),
        authorName: 'Test Author',
        ignoreQuota: true,
      });
      assert.strictEqual(res.status, 403);
      assert.match(res.body.message, /bypass user quota/);
    });

    it('rejects a request filed for another user without manage users', async () => {
      ensureBookshelf(bookshelf);
      await exhaustFriendQuota(mediaType, tmdbId + 1);
      const agent = await loginAs('friend@seerr.dev', 'test1234');

      const res = await agent.post(`${path}/request`).send({
        foreignBookId: String(tmdbId),
        authorName: 'Test Author',
        userId: 1,
      });
      assert.strictEqual(res.status, 403);
      assert.match(res.body.message, /modify the request user/);
      assert.strictEqual(
        await getRepository(Media).count({ where: { tmdbId, mediaType } }),
        0
      );
    });

    it('creates one request when the same book is submitted twice at once', async () => {
      ensureBookshelf(bookshelf);
      const userRepository = getRepository(User);
      const friend = await userRepository.findOneOrFail({
        where: { email: 'friend@seerr.dev' },
      });
      friend.permissions = Permission.REQUEST;
      await userRepository.save(friend);
      const agent = await loginAs('friend@seerr.dev', 'test1234');

      const body = { foreignBookId: String(tmdbId), authorName: 'Test Author' };
      const results = await Promise.all([
        agent.post(`${path}/request`).send(body),
        agent.post(`${path}/request`).send(body),
      ]);

      assert.deepStrictEqual(results.map((r) => r.status).sort(), [201, 202]);
      assert.strictEqual(
        await getRepository(MediaRequest).count({
          where: { type: mediaType, media: { tmdbId } },
        }),
        1
      );
    });
  });
}
