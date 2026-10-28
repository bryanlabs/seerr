import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { checkUser, restrictScopedApiKey } from '@server/middleware/auth';
import { setupTestDb } from '@server/test/db';
import type { Express } from 'express';
import express from 'express';
import request from 'supertest';

const KEY = 'book-request-test-key';

let app: Express;
let priorKey: string | undefined;

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(checkUser);
  app.use(restrictScopedApiKey);
  const echo: express.RequestHandler = (req, res) => {
    res.status(200).json({ userId: req.user?.id ?? null, body: req.body });
  };
  app.get('/audiobook/search', echo);
  app.get('/ebook/:id', echo);
  app.post('/audiobook/request', echo);
  app.post('/ebook/request', echo);
  app.get('/user/:id/quota', echo);
  app.get('/settings/main', echo);
  app.post('/settings/main', echo);
  app.delete('/media/:id', echo);
  app.delete('/request/:id', echo);
  app.post('/request', echo);
  app.post('/audiobook/:id/search', echo);
  return app;
}

before(() => {
  priorKey = process.env.BOOK_REQUEST_API_KEY;
  process.env.BOOK_REQUEST_API_KEY = KEY;
  app = createApp();
});

after(() => {
  if (priorKey === undefined) delete process.env.BOOK_REQUEST_API_KEY;
  else process.env.BOOK_REQUEST_API_KEY = priorKey;
});

setupTestDb();

const scoped = (who: string) => ({ 'X-API-Key': KEY, 'X-API-User': who });

describe('book request API key', () => {
  it('acts as the named user, by username or id', async () => {
    const byName = await request(app)
      .get('/audiobook/search?q=x')
      .set(scoped('friend'));
    assert.strictEqual(byName.status, 200);
    assert.strictEqual(byName.body.userId, 2);

    const byId = await request(app).get('/ebook/123').set(scoped('2'));
    assert.strictEqual(byId.status, 200);
    assert.strictEqual(byId.body.userId, 2);
  });

  it('forces the configured profile, server, folder and tags', async () => {
    const res = await request(app)
      .post('/audiobook/request')
      .set(scoped('friend'))
      .send({
        foreignBookId: '42',
        authorName: 'Someone',
        profileId: 99,
        serverId: 7,
        rootFolder: '/elsewhere',
        tags: [1],
      });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body.body, {
      foreignBookId: '42',
      authorName: 'Someone',
    });
  });

  it('reads only its own quota', async () => {
    const own = await request(app).get('/user/2/quota').set(scoped('friend'));
    assert.strictEqual(own.status, 200);
    const other = await request(app).get('/user/1/quota').set(scoped('friend'));
    assert.strictEqual(other.status, 403);
  });

  it('rejects every route outside book requests, even for an admin', async () => {
    const attempts: [string, string][] = [
      ['get', '/settings/main'],
      ['post', '/settings/main'],
      ['delete', '/media/1'],
      ['delete', '/request/1'],
      ['post', '/request'],
      ['post', '/audiobook/1/search'],
    ];
    for (const [method, path] of attempts) {
      const res = await (
        request(app) as unknown as Record<string, (p: string) => request.Test>
      )
        [method](path)
        .set(scoped('admin'));
      assert.strictEqual(res.status, 403, `${method} ${path}`);
    }
  });

  it('rejects an unknown user or a missing user header', async () => {
    const unknown = await request(app)
      .get('/audiobook/search?q=x')
      .set(scoped('nobody'));
    assert.strictEqual(unknown.status, 403);
    const missing = await request(app)
      .get('/audiobook/search?q=x')
      .set('X-API-Key', KEY);
    assert.strictEqual(missing.status, 403);
  });

  it('does nothing when the key is unset', async () => {
    delete process.env.BOOK_REQUEST_API_KEY;
    try {
      const res = await request(app).get('/settings/main').set(scoped('admin'));
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.userId, null);
    } finally {
      process.env.BOOK_REQUEST_API_KEY = KEY;
    }
  });
});
