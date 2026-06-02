import { createApp } from './router.js';
import { KvStorage } from './storage/kv.js';

export default {
  fetch(request, env) {
    const app = createApp({
      secret: env.SYNC_SECRET,
      storage: new KvStorage(env.TABULABILI_SYNC_KV)
    });
    return app.fetch(request);
  }
};
