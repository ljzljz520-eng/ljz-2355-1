import { getDB } from './db.js';
import { createApp } from './app.js';

const db = await getDB();
const port = Number(process.env.PORT ?? 3000);
createApp(db).listen(port, () => console.log(`售后手册网站: http://localhost:${port} (API: /api)`));
