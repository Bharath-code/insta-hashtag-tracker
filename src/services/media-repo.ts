import type { Knex } from 'knex';
import type { Cursor } from './cursor';

export interface MediaInput {
  id: string;
  media_type: string;
  permalink: string;
  timestamp: string;
  caption?: string;
  media_url?: string;
  like_count?: number;
  comments_count?: number;
}

export interface MediaRow {
  id: string;
  hashtag_id: number;
  caption: string | null;
  media_type: string;
  permalink: string;
  media_url: string | null;
  storage_key: string | null;
  like_count: number;
  comments_count: number;
  posted_at: Date;
  source: string;
}

export interface HashtagRow {
  id: number;
  name: string;
  meta_hashtag_id: string | null;
  last_synced_at: Date | null;
}

export class MediaRepo {
  constructor(private readonly db: Knex) {}

  async upsertBatch(hashtagId: number, source: 'top' | 'recent', items: MediaInput[]): Promise<void> {
    if (items.length === 0) return;
    const rows = items.map((m) => ({
      id: m.id,
      hashtag_id: hashtagId,
      caption: m.caption ?? null,
      media_type: m.media_type,
      permalink: m.permalink,
      media_url: m.media_url ?? null,
      like_count: m.like_count ?? 0,
      comments_count: m.comments_count ?? 0,
      posted_at: m.timestamp,
      source,
      updated_at: this.db.fn.now(),
    }));
    await this.db('media')
      .insert(rows)
      .onConflict('id')
      .merge(['like_count', 'comments_count', 'updated_at']);
  }

  async listPage(limit: number, cursor?: Cursor): Promise<Array<MediaRow & { posted_at_cursor: string }>> {
    let q = this.db('media')
      .orderBy([
        { column: 'posted_at', order: 'desc' },
        { column: 'id', order: 'desc' },
      ])
      .limit(limit);
    if (cursor) q = q.whereRaw('(posted_at, id) < (?, ?)', [cursor.p, cursor.i]);
    // Microsecond-precision cursor value; JS Date truncates to ms, which can skip rows across pages.
    return q.select(
      '*',
      this.db.raw(
        `to_char(posted_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as posted_at_cursor`,
      ),
    );
  }

  async findPendingAssets(hashtagId: number): Promise<Array<{ id: string; media_url: string }>> {
    // Bounded batch: a growing backlog drains over successive syncs instead of ballooning memory.
    return this.db('media')
      .where({ hashtag_id: hashtagId, storage_key: null })
      .whereNotNull('media_url')
      .orderBy('posted_at', 'desc')
      .limit(500)
      .select('id', 'media_url');
  }

  async setStorageKey(id: string, key: string): Promise<void> {
    await this.db('media').where({ id }).update({ storage_key: key, updated_at: this.db.fn.now() });
  }
}

export class HashtagRepo {
  constructor(private readonly db: Knex) {}

  findByName(name: string): Promise<HashtagRow | undefined> {
    return this.db<HashtagRow>('hashtags').where({ name }).first();
  }

  async setMetaId(id: number, metaHashtagId: string): Promise<void> {
    await this.db('hashtags')
      .where({ id })
      .update({ meta_hashtag_id: metaHashtagId, updated_at: this.db.fn.now() });
  }

  async setLastSynced(id: number): Promise<void> {
    await this.db('hashtags')
      .where({ id })
      .update({ last_synced_at: this.db.fn.now(), updated_at: this.db.fn.now() });
  }
}
