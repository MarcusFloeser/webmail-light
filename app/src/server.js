'use strict';

const http = require('http');
const path = require('path');
const express = require('express');
const config = require('./config');
const db = require('./db');
const hub = require('./hub');
const auth = require('./auth');
const manager = require('./imap/manager');
const mailRoutes = require('./mail/routes');
const davRoutes = require('./dav/routes');

async function main() {
  if (config.authMode === 'imap' && !config.authImap.host) {
    console.error('[config] AUTH_MODE=imap braucht AUTH_IMAP_HOST');
    process.exit(1);
  }
  await db.waitForDb();
  await db.migrate();
  await auth.ensureAdmin();

  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', true);

  app.get('/healthz', (req, res) => res.json({ ok: true }));


  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Content-Security-Policy', [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https: http:",
      "font-src 'self' data:",
      "connect-src 'self' ws: wss:",
      "frame-src 'self' blob: data: about:",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'self'",
    ].join('; '));
    next();
  });

  app.use('/api', express.json({ limit: `${config.maxBodyMb}mb` }));
  app.use('/api', auth.csrfGuard);
  app.use('/api', auth.router({
    onUserDeleted: async (accountIds) => { for (const id of accountIds) await manager.stop(id); },
  }));
  app.use('/api', require('./password').router());
  app.use('/api', auth.requireAuth, mailRoutes.router());
  app.use('/api', auth.requireAuth, davRoutes.router());
  app.use('/api', (req, res) => res.status(404).json({ error: 'Unbekannter Endpunkt' }));

  app.use(express.static(path.join(__dirname, '..', 'public'), {
    index: 'index.html',
    setHeaders: (res, file) => {
      if (file.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
    },
  }));
  app.get('*', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

  // Fehlerbehandlung
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
    if (status >= 500) console.error('[http]', req.method, req.originalUrl, err.stack || err.message);
    if (err.type === 'entity.too.large') return res.status(413).json({ error: `Zu groß (max. ${config.maxBodyMb} MB)` });
    res.status(status).json({ error: err.expose === false ? 'Interner Fehler' : (err.message || 'Interner Fehler') });
  });

  const server = http.createServer(app);
  hub.attach(server, auth.userFromRequest);
  server.listen(config.port, () => console.log(`[http] Webmail läuft auf Port ${config.port}`));

  await manager.startAll();

  const shutdown = async (sig) => {
    console.log(`[app] ${sig} – fahre herunter`);
    server.close();
    await manager.stopAll().catch(() => {});
    await db.pool.end().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

process.on('unhandledRejection', (err) => console.error('[app] Unbehandelter Fehler:', err && (err.stack || err.message || err)));

main().catch((err) => {
  console.error('[app] Start fehlgeschlagen:', err);
  process.exit(1);
});
