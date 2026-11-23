/**
 * src/server.js
 * Entry point. Starts the HTTP server, runs no-show sweep on interval.
 */

import { createApp } from './app.js';
import { buildIndex, buildEmbeddings } from './search/index.js';
import { sweepNoShows } from './services/noshow.js';
import { PORT } from './config.js';

const app = createApp();

// Build search index from seed data
buildIndex();

let server = null;

// Only start HTTP listener if not running in a serverless environment (e.g. Vercel)
if (!process.env.VERCEL) {
  // Start server
  server = app.listen(PORT, '0.0.0.0', () => {
    console.log(JSON.stringify({ level: 'info', msg: `LabLink listening on port ${PORT}` }));

    // Build dense embeddings asynchronously (non-blocking, falls back to TF-IDF)
    buildEmbeddings().catch(() => { /* non-fatal */ });
  });

  // No-show sweep: run on unref'd interval so it doesn't prevent graceful shutdown
  const noShowInterval = setInterval(() => {
    sweepNoShows();
  }, 60_000);
  noShowInterval.unref();

  // ── Graceful SIGTERM shutdown ─────────────────────────────────────────────────
  process.on('SIGTERM', () => {
    console.log(JSON.stringify({ level: 'info', msg: 'SIGTERM received, shutting down gracefully' }));
    clearInterval(noShowInterval);
    server.close(() => {
      console.log(JSON.stringify({ level: 'info', msg: 'Server closed' }));
      process.exit(0);
    });
    // Force exit after 10s
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}

export default app;
export { server, app };
