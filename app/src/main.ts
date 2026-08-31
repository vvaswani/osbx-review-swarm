/**
 * Fastify application factory for the books CRUD service.
 *
 * Replaces app/main.py (FastAPI app factory).
 * Can be run directly with `bun run src/main.ts` or imported as a module.
 */

import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { registerRoutes } from './routers';
import { pool } from './db';
import { config } from 'dotenv';

config();

/**
 * Create and configure the Fastify application.
 */
export function createApp(): FastifyInstance {
  const isDev = process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'dev';

  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL || (isDev ? 'debug' : 'info'),
      ...(isDev && {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'HH:MM:ss',
          },
        },
      }),
    },
    routerOptions: { ignoreTrailingSlash: true },
  });

  // Register cleanup hook for graceful shutdown
  app.addHook('onClose', async () => {
    await pool.end();
  });

  // Register API routes
  registerRoutes(app);

  return app;
}

// ── CLI entry point ──────────────────────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = parseInt(process.env.PORT || '8000', 10);

  const app = createApp();

  // Handle termination signals gracefully
  // Note: initDb() is intentionally NOT called here — the database schema
  // should be provisioned externally (e.g. via Docker db.sql mount or
  // a migration tool) before the app starts.
  app
    .listen({ port, host: '0.0.0.0' })
    .then(() => console.log(`App listening on port ${port}`))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });

  process.on('SIGTERM', async () => {
    console.log('SIGTERM received, closing server...');
    await app.close();
  });

  process.on('SIGINT', async () => {
    console.log('SIGINT received, closing server...');
    await app.close();
  });
}
