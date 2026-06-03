import { createApp } from './router.js';
import { D1Storage } from './storage/d1.js';

let cachedApp = null;
let cachedDb = null;
let cachedSecret = '';

function getApp(env) {
  if (cachedApp && cachedDb === env.TABULABILI_SYNC_DB && cachedSecret === env.SYNC_SECRET) {
    return cachedApp;
  }

  cachedDb = env.TABULABILI_SYNC_DB;
  cachedSecret = env.SYNC_SECRET;
  cachedApp = createApp({
    secret: env.SYNC_SECRET,
    storage: new D1Storage(env.TABULABILI_SYNC_DB)
  });
  return cachedApp;
}

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
    return getApp(env).fetch(request);
  }
};
