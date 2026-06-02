import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/router.js';
import { MemoryStorage } from '../src/storage/memory.js';

test('api routes require bearer secret', async () => {
  const app = createApp({ secret: 'secret', storage: new MemoryStorage() });
  const rejected = await app.fetch(new Request('http://local/api/config'));
  assert.equal(rejected.status, 401);

  const accepted = await app.fetch(new Request('http://local/api/auth/check', {
    method: 'POST',
    headers: { authorization: 'Bearer secret' }
  }));
  assert.equal(accepted.status, 200);
});

test('config sync returns merged materialized config', async () => {
  const app = createApp({ secret: 'secret', storage: new MemoryStorage() });
  const response = await app.fetch(new Request('http://local/api/config/sync', {
    method: 'POST',
    headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
    body: JSON.stringify({
      config: {
        fields: {
          bili_mode: { value: 'fusion', updatedAt: '2026-01-01T00:00:00.000Z', clientId: 'c1' }
        },
        rules: { items: [] }
      }
    })
  }));

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.materialized.bili_mode, 'fusion');
});
