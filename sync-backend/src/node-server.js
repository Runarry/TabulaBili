import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createApp } from './router.js';
import { SqliteStorage } from './storage/sqlite.js';

const port = Number(process.env.PORT || 8787);
const dbPath = process.env.SQLITE_PATH || './data/tabulabili-sync.db';
mkdirSync(dirname(dbPath), { recursive: true });

const app = createApp({
  secret: process.env.SYNC_SECRET,
  storage: new SqliteStorage(dbPath)
});

createServer(async (req, res) => {
  const request = new Request(`http://${req.headers.host}${req.url}`, {
    method: req.method,
    headers: req.headers,
    body: req.method === 'GET' || req.method === 'HEAD' ? undefined : req,
    duplex: 'half'
  });
  const response = await app.fetch(request);
  res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
  if (response.body) {
    const buffer = Buffer.from(await response.arrayBuffer());
    res.end(buffer);
  } else {
    res.end();
  }
}).listen(port, () => {
  console.log(`TabulaBili Sync listening on http://0.0.0.0:${port}`);
});
