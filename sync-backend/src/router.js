import { adminPage } from './admin-page.js';
import { materializeConfig, mergeConfig, normalizeEnvelope } from './config-merge.js';
import { normalizeReportPayload } from './report-aggregate.js';

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...corsHeaders()
    }
  });
}

function text(value, status = 200, contentType = 'text/plain; charset=utf-8') {
  return new Response(value, {
    status,
    headers: {
      'content-type': contentType,
      ...corsHeaders()
    }
  });
}

function corsHeaders() {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'authorization,content-type'
  };
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function getBearer(request, url) {
  const header = request.headers.get('authorization') || '';
  if (header.toLowerCase().startsWith('bearer ')) return header.slice(7).trim();
  return url.searchParams.get('auth') || '';
}

function createApp(options) {
  const storage = options.storage;
  const secret = options.secret;
  if (!storage) throw new Error('storage is required');
  if (!secret) throw new Error('SYNC_SECRET is required');

  async function requireAuth(request, url) {
    return getBearer(request, url) === secret;
  }

  return {
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders() });
      if (url.pathname === '/' || url.pathname === '/index.html') {
        return text(adminPage(), 200, 'text/html; charset=utf-8');
      }
      if (!url.pathname.startsWith('/api/')) return json({ error: 'not_found' }, 404);
      if (!(await requireAuth(request, url))) return json({ error: 'unauthorized' }, 401);

      if (url.pathname === '/api/auth/check' && request.method === 'POST') {
        return json({ ok: true });
      }

      if (url.pathname === '/api/config/sync' && request.method === 'POST') {
        const body = await readJson(request);
        const current = await storage.getConfig();
        const merged = mergeConfig(current, body && body.config ? body.config : body);
        await storage.saveConfig(merged);
        return json({ config: normalizeEnvelope(merged), materialized: materializeConfig(merged) });
      }

      if (url.pathname === '/api/config' && request.method === 'GET') {
        const config = normalizeEnvelope(await storage.getConfig());
        return json({ config, materialized: materializeConfig(config) });
      }

      if (url.pathname === '/api/reports' && request.method === 'POST') {
        const body = await readJson(request);
        const payload = normalizeReportPayload(body);
        if (!payload.batchId || !payload.clientId) return json({ error: 'invalid_batch' }, 400);
        const result = await storage.saveReportBatch(payload);
        return json({ ok: true, ...result });
      }

      if (url.pathname === '/api/reports/summary' && request.method === 'GET') {
        return json(await storage.getReportSummary());
      }

      if (url.pathname === '/api/reports/batches' && request.method === 'GET') {
        return json(await storage.listReportBatches({
          limit: Number(url.searchParams.get('limit') || 50),
          offset: Number(url.searchParams.get('offset') || 0)
        }));
      }

      if (url.pathname === '/api/reports/samples' && request.method === 'GET') {
        const result = await storage.listReportSamples({
          limit: Number(url.searchParams.get('limit') || 50),
          offset: Number(url.searchParams.get('offset') || 0),
          q: url.searchParams.get('q') || ''
        });
        if (url.searchParams.get('export') === '1') {
          return text(JSON.stringify(result.items, null, 2), 200, 'application/json; charset=utf-8');
        }
        return json(result);
      }

      return json({ error: 'not_found' }, 404);
    }
  };
}

export { createApp };
