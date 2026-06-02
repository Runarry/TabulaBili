import { createApp } from './router.js';
import { D1Storage } from './storage/d1.js';

export default {
  fetch(request, env) {
    if (!env.TABULABILI_SYNC_DB) {
      return new Response(JSON.stringify({
        error: 'missing_d1_binding',
        message: 'Cloudflare D1 binding TABULABILI_SYNC_DB is required'
      }), {
        status: 500,
        headers: { 'content-type': 'application/json; charset=utf-8' }
      });
    }
    const app = createApp({
      secret: env.SYNC_SECRET,
      storage: new D1Storage(env.TABULABILI_SYNC_DB)
    });
    return app.fetch(request);
  }
};
