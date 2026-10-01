import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createStore } from './db/store.js';
import { seedStore } from './db/seed.js';
import { handleApi } from './api/router.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DOCS_DIR = path.resolve(__dirname, '..', 'docs');
const PORT = Number(process.env.PORT || 4173);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

function safeJoin(root, urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const target = path.normalize(path.join(root, decoded));
  return target.startsWith(root) ? target : null;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname.startsWith('/api/') || url.pathname === '/api') {
    try {
      await handleApi(req, res, url, db);
    } catch (e) {
      console.error(e);
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: '内部错误' }));
      }
    }
    return;
  }
  // 静态：docs 根工程（离线站点）
  let filePath = safeJoin(DOCS_DIR, url.pathname === '/' ? '/index.html' : url.pathname);
  if (!filePath) { res.writeHead(400); return res.end('bad path'); }
  try {
    let data = await readFile(filePath);
    res.writeHead(200, { 'content-type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    // 非文件路径回退到 index.html（SPA）
    try {
      const idx = await readFile(path.join(DOCS_DIR, 'index.html'));
      res.writeHead(200, { 'content-type': MIME['.html'] });
      res.end(idx);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('docs 尚未构建');
    }
  }
});

const { db, close } = await createStore();
await seedStore(db);
server.listen(PORT, () => {
  console.log(`售后手册网站: http://localhost:${PORT}  (store: ${db.kind})`);
});

const shutdown = async () => { server.close(async () => { await close?.(); process.exit(0); }); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
