import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createApi } from './api.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function createApp(db) {
  const app = express();
  app.use('/api', createApi(db));
  app.use(express.static(join(__dirname, '..', 'docs')));
  app.use((err, _req, res, _next) => {
    console.error(err);
    res.status(500).json({ error: 'INTERNAL', message: err.message });
  });
  return app;
}
