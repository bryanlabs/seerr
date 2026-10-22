import assert from 'node:assert/strict';
import { before, beforeEach, describe, it, mock } from 'node:test';

import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import SeasonRequest from '@server/entity/SeasonRequest';
import { User } from '@server/entity/User';
import { getSettings } from '@server/lib/settings';
import { checkUser } from '@server/middleware/auth';
import { MediaRequestSubscriber } from '@server/subscriber/MediaRequestSubscriber';
import { setupTestDb } from '@server/test/db';
import {
  assertNoCredentials,
  seedUserSettings,
} from '@server/test/userSettings';
import type { Express } from 'express';
import express from 'express';
import session from 'express-session';
import request from 'supertest';
import authRoutes from './auth';
import requestRoutes from './request';

const sendNotificationMock = mock.method(
  MediaRequest,
  'sendNotification',
  async () => undefined
).mock;

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
  app.use('/request', requestRoutes);
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

beforeEach(() => {
  sendNotificationMock.resetCalls();
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

async function seedRequest(status = MediaRequestStatus.PENDING) {
  const userRepo = getRepository(User);
  const mediaRepo = getRepository(Media);
  const requestRepo = getRepository(MediaRequest);

  const requestedBy = await userRepo.findOneOrFail({
    where: { email: 'friend@seerr.dev' },
  });

  const media = await mediaRepo.save(
    new Media({
      mediaType: MediaType.MOVIE,
      tmdbId: 12345,
      status: MediaStatus.UNKNOWN,
      status4k: MediaStatus.UNKNOWN,
    })
  );

  const created = await requestRepo.save(
    new MediaRequest({
      type: MediaType.MOVIE,
      status,
      media,
      requestedBy,
      is4k: false,
      updatedAt: new Date('2025-03-01T00:00:00.000Z'),
    })
  );

  return requestRepo.findOneOrFail({
    where: { id: created.id },
    relations: { requestedBy: true, modifiedBy: true },
  });
}

describe('DELETE /request/:requestId', () => {
  it('allows the owner to delete their own pending request', async () => {
    const mediaRequest = await seedRequest();

    const agent = await loginAs('friend@seerr.dev', 'test1234');
    const res = await agent.delete(`/request/${mediaRequest.id}`);

    assert.strictEqual(res.status, 204);
  });

  it('allows an admin to delete any pending request', async () => {
    const mediaRequest = await seedRequest();

    const agent = await loginAs('admin@seerr.dev', 'test1234');
    const res = await agent.delete(`/request/${mediaRequest.id}`);

    assert.strictEqual(res.status, 204);
  });

  it('prevents a non-owner non-admin from deleting a pending request', async () => {
    const userRepo = getRepository(User);
    const mediaRepo = getRepository(Media);
    const requestRepo = getRepository(MediaRequest);

    // Create a request owned by admin, then try to delete as friend
    const owner = await userRepo.findOneOrFail({
      where: { email: 'admin@seerr.dev' },
    });

    const media = await mediaRepo.save(
      new Media({
        mediaType: MediaType.MOVIE,
        tmdbId: 54321,
        status: MediaStatus.UNKNOWN,
        status4k: MediaStatus.UNKNOWN,
      })
    );

    const mediaRequest = await requestRepo.save(
      new MediaRequest({
        type: MediaType.MOVIE,
        status: MediaRequestStatus.PENDING,
        media,
        requestedBy: owner,
        is4k: false,
      })
    );

    const agent = await loginAs('friend@seerr.dev', 'test1234');
    const res = await agent.delete(`/request/${mediaRequest.id}`);

    assert.strictEqual(res.status, 401);
  });

  it('prevents the owner from deleting an approved request', async () => {
    const mediaRequest = await seedRequest(MediaRequestStatus.APPROVED);

    const agent = await loginAs('friend@seerr.dev', 'test1234');
    const res = await agent.delete(`/request/${mediaRequest.id}`);

    assert.strictEqual(res.status, 401);
  });

  it('returns 404 for a non-existent request', async () => {
    const agent = await loginAs('admin@seerr.dev', 'test1234');
    const res = await agent.delete('/request/99999999');

    assert.strictEqual(res.status, 404);
  });

  it('deletes a request once when two deletes race', async () => {
    const repo = getRepository(MediaRequest);
    const mediaRequest = await seedRequest();
    const admin = await loginAs('admin@seerr.dev', 'test1234');

    const results = await Promise.all([
      admin.delete(`/request/${mediaRequest.id}`),
      admin.delete(`/request/${mediaRequest.id}`),
    ]);

    assert.deepStrictEqual(results.map((r) => r.status).sort(), [204, 404]);
    assert.strictEqual(await repo.count({ where: { id: mediaRequest.id } }), 0);
  });
});

describe('PUT /request/:requestId (movie)', () => {
  it('persists server and root folder changes to the database', async () => {
    const requestRepo = getRepository(MediaRequest);
    const mediaRequest = await seedRequest();

    const agent = await loginAs('admin@seerr.dev', 'test1234');
    const res = await agent.put(`/request/${mediaRequest.id}`).send({
      mediaType: MediaType.MOVIE,
      serverId: 3,
      profileId: 7,
      rootFolder: '/updated/movies',
      tags: [1, 2],
    });

    assert.strictEqual(res.status, 200);

    const saved = await requestRepo.findOneOrFail({
      where: { id: mediaRequest.id },
    });
    assert.strictEqual(saved.serverId, 3);
    assert.strictEqual(saved.profileId, 7);
    assert.strictEqual(saved.rootFolder, '/updated/movies');
  });

  it('refuses to modify a request that is no longer pending', async () => {
    const requestRepo = getRepository(MediaRequest);
    const mediaRequest = await seedRequest(MediaRequestStatus.APPROVED);

    const agent = await loginAs('admin@seerr.dev', 'test1234');
    const res = await agent.put(`/request/${mediaRequest.id}`).send({
      mediaType: MediaType.MOVIE,
      serverId: 3,
      rootFolder: '/updated/movies',
    });

    assert.strictEqual(res.status, 409);
    assert.match(res.body.message, /pending/i);

    const saved = await requestRepo.findOneOrFail({
      where: { id: mediaRequest.id },
    });
    assert.strictEqual(saved.serverId, null);
    assert.strictEqual(saved.rootFolder, null);
  });
});

async function seedUser(
  email: string,
  quotas: {
    movieQuotaLimit?: number;
    tvQuotaLimit?: number;
    tvQuotaDays?: number;
  } = {}
) {
  const userRepo = getRepository(User);
  const user = await userRepo.findOneOrFail({ where: { email } });
  Object.assign(user, quotas);

  return userRepo.save(user);
}

async function seedTvMedia(tmdbId: number) {
  const mediaRepo = getRepository(Media);

  return (
    (await mediaRepo.findOne({
      where: { tmdbId, mediaType: MediaType.TV },
    })) ??
    (await mediaRepo.save(
      new Media({
        mediaType: MediaType.TV,
        tmdbId,
        status: MediaStatus.PENDING,
        status4k: MediaStatus.UNKNOWN,
      })
    ))
  );
}

async function seedTvRequest(
  requestedBy: User,
  seasons: number[],
  { tmdbId = 67890, ignoreQuota = false, createdAt = new Date() } = {}
) {
  return getRepository(MediaRequest).save(
    new MediaRequest({
      type: MediaType.TV,
      status: MediaRequestStatus.PENDING,
      media: await seedTvMedia(tmdbId),
      requestedBy,
      is4k: false,
      ignoreQuota,
      createdAt,
      seasons: seasons.map(
        (seasonNumber) =>
          new SeasonRequest({
            seasonNumber,
            status: MediaRequestStatus.PENDING,
          })
      ),
    })
  );
}

describe('PUT /request/:requestId (tv)', () => {
  it('does not add a season held by another request', async () => {
    const requestRepo = getRepository(MediaRequest);

    const owner = await seedUser('admin@seerr.dev');
    const otherUser = await seedUser('friend@seerr.dev');

    const mediaRequest = await seedTvRequest(owner, [1, 2]);
    const otherRequest = await seedTvRequest(otherUser, [3]);

    const agent = await loginAs('admin@seerr.dev', 'test1234');
    const res = await agent.put(`/request/${mediaRequest.id}`).send({
      mediaType: MediaType.TV,
      seasons: [1, 2, 3],
    });

    assert.strictEqual(res.status, 200);

    const saved = await requestRepo.findOneOrFail({
      where: { id: mediaRequest.id },
    });
    assert.deepStrictEqual(
      saved.seasons.map((s) => s.seasonNumber).sort((a, b) => a - b),
      [1, 2]
    );

    const otherSaved = await requestRepo.findOneOrFail({
      where: { id: otherRequest.id },
    });
    assert.deepStrictEqual(
      otherSaved.seasons.map((s) => s.seasonNumber),
      [3]
    );
  });
});

describe('PUT /request/:requestId (quota)', () => {
  it('rejects adding seasons beyond the season limit', async () => {
    const requestRepo = getRepository(MediaRequest);
    const owner = await seedUser('friend@seerr.dev', { tvQuotaLimit: 2 });
    const mediaRequest = await seedTvRequest(owner, [1, 2]);

    const agent = await loginAs('friend@seerr.dev', 'test1234');
    const res = await agent.put(`/request/${mediaRequest.id}`).send({
      mediaType: MediaType.TV,
      seasons: [1, 2, 3],
    });

    assert.strictEqual(res.status, 403);

    const saved = await requestRepo.findOneOrFail({
      where: { id: mediaRequest.id },
    });
    assert.deepStrictEqual(
      saved.seasons.map((s) => s.seasonNumber).sort((a, b) => a - b),
      [1, 2]
    );
  });

  it('rejects adding seasons to a request older than the quota window', async () => {
    const requestRepo = getRepository(MediaRequest);
    const owner = await seedUser('friend@seerr.dev', {
      tvQuotaLimit: 2,
      tvQuotaDays: 7,
    });
    const mediaRequest = await seedTvRequest(owner, [1, 2], {
      createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
    });

    const agent = await loginAs('friend@seerr.dev', 'test1234');
    const res = await agent.put(`/request/${mediaRequest.id}`).send({
      mediaType: MediaType.TV,
      seasons: [1, 2, 3],
    });

    assert.strictEqual(res.status, 403);

    const saved = await requestRepo.findOneOrFail({
      where: { id: mediaRequest.id },
    });
    assert.deepStrictEqual(
      saved.seasons.map((s) => s.seasonNumber).sort((a, b) => a - b),
      [1, 2]
    );
  });

  it('allows swapping seasons at the season limit', async () => {
    const requestRepo = getRepository(MediaRequest);
    const owner = await seedUser('friend@seerr.dev', { tvQuotaLimit: 2 });
    const mediaRequest = await seedTvRequest(owner, [1, 2]);

    const agent = await loginAs('friend@seerr.dev', 'test1234');
    const res = await agent.put(`/request/${mediaRequest.id}`).send({
      mediaType: MediaType.TV,
      seasons: [3, 4],
    });

    assert.strictEqual(res.status, 200);

    const saved = await requestRepo.findOneOrFail({
      where: { id: mediaRequest.id },
    });
    assert.deepStrictEqual(
      saved.seasons.map((s) => s.seasonNumber).sort((a, b) => a - b),
      [3, 4]
    );
  });

  it('rejects reassignment to a user without room for the existing seasons', async () => {
    const requestRepo = getRepository(MediaRequest);
    const owner = await seedUser('admin@seerr.dev');
    const target = await seedUser('friend@seerr.dev', { tvQuotaLimit: 1 });
    const mediaRequest = await seedTvRequest(owner, [1, 2]);

    const agent = await loginAs('admin@seerr.dev', 'test1234');
    const res = await agent.put(`/request/${mediaRequest.id}`).send({
      mediaType: MediaType.TV,
      seasons: [1, 2],
      userId: target.id,
    });

    assert.strictEqual(res.status, 403);

    const saved = await requestRepo.findOneOrFail({
      where: { id: mediaRequest.id },
    });
    assert.strictEqual(saved.requestedBy.id, owner.id);
  });

  it('rejects reassignment of a movie request to a user at their limit', async () => {
    const requestRepo = getRepository(MediaRequest);
    const mediaRepo = getRepository(Media);

    const owner = await seedUser('admin@seerr.dev');
    const target = await seedUser('friend@seerr.dev', { movieQuotaLimit: 1 });

    // Uses up the target's single movie request
    await seedRequest();

    const media = await mediaRepo.save(
      new Media({
        mediaType: MediaType.MOVIE,
        tmdbId: 55555,
        status: MediaStatus.PENDING,
        status4k: MediaStatus.UNKNOWN,
      })
    );
    const mediaRequest = await requestRepo.save(
      new MediaRequest({
        type: MediaType.MOVIE,
        status: MediaRequestStatus.PENDING,
        media,
        requestedBy: owner,
        is4k: false,
      })
    );

    const agent = await loginAs('admin@seerr.dev', 'test1234');
    const res = await agent.put(`/request/${mediaRequest.id}`).send({
      mediaType: MediaType.MOVIE,
      userId: target.id,
    });

    assert.strictEqual(res.status, 403);

    const saved = await requestRepo.findOneOrFail({
      where: { id: mediaRequest.id },
    });
    assert.strictEqual(saved.requestedBy.id, owner.id);
  });

  it('allows reassignment to a user who bypasses quotas', async () => {
    const requestRepo = getRepository(MediaRequest);
    const owner = await seedUser('friend@seerr.dev', { tvQuotaLimit: 1 });
    const target = await seedUser('admin@seerr.dev');
    const mediaRequest = await seedTvRequest(owner, [1, 2]);

    const agent = await loginAs('admin@seerr.dev', 'test1234');
    const res = await agent.put(`/request/${mediaRequest.id}`).send({
      mediaType: MediaType.TV,
      seasons: [1, 2],
      userId: target.id,
    });

    assert.strictEqual(res.status, 200);

    const saved = await requestRepo.findOneOrFail({
      where: { id: mediaRequest.id },
    });
    assert.strictEqual(saved.requestedBy.id, target.id);
  });

  it('allows an edit that exceeds the limit when the request ignores quota', async () => {
    const requestRepo = getRepository(MediaRequest);
    const owner = await seedUser('friend@seerr.dev', { tvQuotaLimit: 2 });

    await seedTvRequest(owner, [1, 2], { tmdbId: 77777 });
    const mediaRequest = await seedTvRequest(owner, [1, 2], {
      ignoreQuota: true,
    });

    const agent = await loginAs('friend@seerr.dev', 'test1234');
    const res = await agent.put(`/request/${mediaRequest.id}`).send({
      mediaType: MediaType.TV,
      seasons: [1, 2, 3],
    });

    assert.strictEqual(res.status, 200);

    const saved = await requestRepo.findOneOrFail({
      where: { id: mediaRequest.id },
    });
    assert.deepStrictEqual(
      saved.seasons.map((s) => s.seasonNumber).sort((a, b) => a - b),
      [1, 2, 3]
    );
  });
});

describe('GET /request/:requestId', () => {
  it('omits notification settings from requestedBy and modifiedBy', async () => {
    const pending = await seedRequest();
    await seedUserSettings('friend@seerr.dev');
    await seedUserSettings('admin@seerr.dev');

    const admin = await loginAs('admin@seerr.dev', 'test1234');
    const approved = await admin.post(`/request/${pending.id}/approve`);
    assert.strictEqual(approved.status, 200);

    const res = await admin.get(`/request/${pending.id}`);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.requestedBy.email, 'friend@seerr.dev');
    assert.strictEqual(res.body.modifiedBy.email, 'admin@seerr.dev');
    assert.ok(!('settings' in res.body.requestedBy));
    assert.ok(!('settings' in res.body.modifiedBy));
    assertNoCredentials(res.body);
  });
});

describe('POST /request/:requestId/:status', () => {
  const cases = [
    { action: 'approve', expected: MediaRequestStatus.APPROVED },
    { action: 'decline', expected: MediaRequestStatus.DECLINED },
  ] as const;

  for (const { action, expected } of cases) {
    it(`transitions to ${action}d and records the acting user`, async () => {
      const repo = getRepository(MediaRequest);
      const pending = await seedRequest();
      const admin = await loginAs('admin@seerr.dev', 'test1234');

      const res = await admin.post(`/request/${pending.id}/${action}`);

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.status, expected);
      assert.strictEqual(res.body.modifiedBy.email, 'admin@seerr.dev');

      const persisted = await repo.findOneOrFail({
        where: { id: pending.id },
        relations: { modifiedBy: true },
      });

      assert.strictEqual(persisted.status, expected);
      assert.strictEqual(persisted.modifiedBy?.email, 'admin@seerr.dev');
      assert.ok(persisted.updatedAt > pending.updatedAt);
    });
  }

  it('rejects a status the route does not define', async () => {
    const repo = getRepository(MediaRequest);
    const pending = await seedRequest();
    const admin = await loginAs('admin@seerr.dev', 'test1234');

    const res = await admin.post(`/request/${pending.id}/frobnicate`);

    assert.strictEqual(res.status, 400);
    assert.match(res.body.message, /approve/i);

    const persisted = await repo.findOneOrFail({
      where: { id: pending.id },
      relations: { modifiedBy: true },
    });
    assert.strictEqual(persisted.status, MediaRequestStatus.PENDING);
    assert.ok(!persisted.modifiedBy);
  });

  it('refuses to act on a request that is no longer pending', async () => {
    const repo = getRepository(MediaRequest);
    const approved = await seedRequest(MediaRequestStatus.APPROVED);
    const admin = await loginAs('admin@seerr.dev', 'test1234');

    const res = await admin.post(`/request/${approved.id}/decline`);

    assert.strictEqual(res.status, 409);
    assert.match(res.body.message, /pending/i);

    const persisted = await repo.findOneOrFail({ where: { id: approved.id } });
    assert.strictEqual(persisted.status, MediaRequestStatus.APPROVED);
  });

  it('applies only one of a concurrent approve and decline', async () => {
    const repo = getRepository(MediaRequest);
    const pending = await seedRequest();
    const admin = await loginAs('admin@seerr.dev', 'test1234');

    const [approve, decline] = await Promise.all([
      admin.post(`/request/${pending.id}/approve`),
      admin.post(`/request/${pending.id}/decline`),
    ]);

    assert.deepStrictEqual([approve.status, decline.status].sort(), [200, 409]);

    const persisted = await repo.findOneOrFail({ where: { id: pending.id } });
    assert.strictEqual(
      persisted.status,
      approve.status === 200
        ? MediaRequestStatus.APPROVED
        : MediaRequestStatus.DECLINED
    );
  });

  it('rejects the removed pending verb even on a non-pending request', async () => {
    const repo = getRepository(MediaRequest);
    const declined = await seedRequest(MediaRequestStatus.DECLINED);
    const admin = await loginAs('admin@seerr.dev', 'test1234');

    const res = await admin.post(`/request/${declined.id}/pending`);

    assert.strictEqual(res.status, 400);
    assert.match(res.body.message, /approve/i);

    const persisted = await repo.findOneOrFail({ where: { id: declined.id } });
    assert.strictEqual(persisted.status, MediaRequestStatus.DECLINED);
  });
});

describe('POST /request/:requestId/retry', () => {
  it('re-approves a failed request and records the acting user', async () => {
    const repo = getRepository(MediaRequest);
    const failed = await seedRequest(MediaRequestStatus.FAILED);
    const admin = await loginAs('admin@seerr.dev', 'test1234');

    const res = await admin.post(`/request/${failed.id}/retry`);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.status, MediaRequestStatus.APPROVED);
    assert.strictEqual(res.body.modifiedBy.email, 'admin@seerr.dev');

    const persisted = await repo.findOneOrFail({
      where: { id: failed.id },
      relations: { modifiedBy: true },
    });

    assert.strictEqual(persisted.status, MediaRequestStatus.APPROVED);
    assert.strictEqual(persisted.modifiedBy?.email, 'admin@seerr.dev');
    assert.ok(persisted.updatedAt > failed.updatedAt);
  });

  it('refuses to retry a request that has not failed', async () => {
    const repo = getRepository(MediaRequest);
    const pending = await seedRequest();
    const admin = await loginAs('admin@seerr.dev', 'test1234');

    const res = await admin.post(`/request/${pending.id}/retry`);

    assert.strictEqual(res.status, 409);
    assert.match(res.body.message, /failed/i);

    const persisted = await repo.findOneOrFail({ where: { id: pending.id } });
    assert.strictEqual(persisted.status, MediaRequestStatus.PENDING);
  });

  it('sends a concurrently retried request to *arr once', async (t) => {
    const repo = getRepository(MediaRequest);
    const failed = await seedRequest(MediaRequestStatus.FAILED);
    const admin = await loginAs('admin@seerr.dev', 'test1234');

    const sendToRadarr = t.mock.method(
      MediaRequestSubscriber.prototype,
      'sendToRadarr',
      async () => undefined
    );

    const results = await Promise.all([
      admin.post(`/request/${failed.id}/retry`),
      admin.post(`/request/${failed.id}/retry`),
    ]);

    assert.deepStrictEqual(results.map((r) => r.status).sort(), [200, 409]);
    assert.strictEqual(sendToRadarr.mock.callCount(), 1);

    const persisted = await repo.findOneOrFail({ where: { id: failed.id } });
    assert.strictEqual(persisted.status, MediaRequestStatus.APPROVED);
  });
});
