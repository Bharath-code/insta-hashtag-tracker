import express, { Express, NextFunction, Request, Response } from 'express';
import type { Knex } from 'knex';
import { MediaRepo } from './services/media-repo';
import { decodeCursor, encodeCursor } from './services/cursor';

export function createApp(db: Knex): Express {
  const app = express();
  const media = new MediaRepo(db);

  app.get('/', (_req: Request, res: Response) => {
    res.json({
      service: 'hashtag-tracker',
      health: '/health',
      hashtags: '/hashtags?limit=5',
    });
  });

  app.get('/health', (_req: Request, res: Response) => {
    res.json({ ok: true });
  });

  app.get('/hashtags', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const rawLimit = Number(req.query.limit);
      const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? rawLimit : 20, 1), 100);

      let cursor;
      if (req.query.cursor !== undefined) {
        cursor = decodeCursor(String(req.query.cursor));
        if (!cursor) {
          res.status(400).json({ error: 'invalid cursor' });
          return;
        }
      }

      const rows = await media.listPage(limit, cursor ?? undefined);
      const last = rows[rows.length - 1];
      const nextCursor =
        rows.length === limit && last ? encodeCursor({ p: last.posted_at_cursor, i: last.id }) : null;
      res.json({ data: rows.map(({ posted_at_cursor, ...row }) => row), nextCursor });
    } catch (err) {
      next(err);
    }
  });

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  });

  return app;
}
