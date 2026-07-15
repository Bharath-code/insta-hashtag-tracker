import { z } from 'zod';

const mediaSchema = z.object({
  id: z.string(),
  media_type: z.string(),
  permalink: z.string(),
  timestamp: z.string(),
  caption: z.string().optional(),
  media_url: z.string().optional(),
  like_count: z.number().optional(),
  comments_count: z.number().optional(),
});

const pageSchema = z.object({
  data: z.array(mediaSchema),
  paging: z
    .object({
      cursors: z.object({ after: z.string().optional() }).optional(),
      next: z.string().optional(),
    })
    .optional(),
});

const searchSchema = z.object({ data: z.array(z.object({ id: z.string() })).min(1) });

export type MetaMedia = z.infer<typeof mediaSchema>;

const FIELDS = 'id,media_type,timestamp,permalink,media_url,caption,like_count,comments_count';
const MAX_ATTEMPTS = 3;

export class MetaApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'MetaApiError';
  }
}

export interface MetaClientOptions {
  accessToken: string;
  userId: string;
  baseUrl: string;
  pageSize?: number;
  fetchFn?: typeof fetch;
  sleepFn?: (ms: number) => Promise<void>;
}

export class MetaClient {
  constructor(private readonly opts: MetaClientOptions) {}

  private async request(url: string): Promise<unknown> {
    const fetchFn = this.opts.fetchFn ?? fetch;
    const sleep = this.opts.sleepFn ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    for (let attempt = 1; ; attempt++) {
      const res = await fetchFn(url);
      if (res.ok) return res.json();
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= MAX_ATTEMPTS) {
        throw new MetaApiError(res.status, `Meta API ${res.status}: ${await res.text()}`);
      }
      await sleep(500 * 2 ** (attempt - 1));
    }
  }

  private buildUrl(path: string, params: Record<string, string>): string {
    const u = new URL(`${this.opts.baseUrl}/${path}`);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    u.searchParams.set('user_id', this.opts.userId);
    u.searchParams.set('access_token', this.opts.accessToken);
    return u.toString();
  }

  async searchHashtag(name: string): Promise<string> {
    const body = searchSchema.parse(await this.request(this.buildUrl('ig_hashtag_search', { q: name })));
    return body.data[0].id;
  }

  async *fetchHashtagMedia(
    hashtagId: string,
    edge: 'top_media' | 'recent_media',
    maxItems: number,
  ): AsyncGenerator<MetaMedia[]> {
    const pageSize = this.opts.pageSize ?? 50;
    let after: string | undefined;
    let fetched = 0;
    while (fetched < maxItems) {
      const params: Record<string, string> = {
        fields: FIELDS,
        limit: String(Math.min(pageSize, maxItems - fetched)),
      };
      if (after) params.after = after;
      const page = pageSchema.parse(await this.request(this.buildUrl(`${hashtagId}/${edge}`, params)));
      if (page.data.length === 0) return;
      yield page.data;
      fetched += page.data.length;
      after = page.paging?.cursors?.after;
      if (!after || !page.paging?.next) return;
    }
  }
}
