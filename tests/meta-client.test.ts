import { describe, it, expect, vi } from 'vitest';
import { MetaClient, MetaApiError } from '../src/meta/client';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function makeClient(fetchFn: typeof fetch) {
  return new MetaClient({
    accessToken: 'tok',
    userId: 'u1',
    baseUrl: 'https://graph.test/v24.0',
    pageSize: 2,
    fetchFn,
    sleepFn: async () => {},
  });
}

const media = (id: string) => ({
  id,
  media_type: 'IMAGE',
  permalink: `https://ig/p/${id}`,
  timestamp: '2026-07-15T10:00:00+0000',
});

describe('MetaClient', () => {
  it('searchHashtag returns first hashtag id', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ data: [{ id: 'h123' }] }));
    const id = await makeClient(fetchFn as typeof fetch).searchHashtag('matcha');
    expect(id).toBe('h123');
    const url = new URL(fetchFn.mock.calls[0][0] as string);
    expect(url.pathname).toBe('/v24.0/ig_hashtag_search');
    expect(url.searchParams.get('q')).toBe('matcha');
  });

  it('paginates via after cursor and stops at maxItems', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          data: [media('1'), media('2')],
          paging: { cursors: { after: 'A' }, next: 'https://next' },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          data: [media('3')],
          paging: { cursors: { after: 'B' }, next: 'https://next2' },
        }),
      );
    const pages: string[][] = [];
    for await (const page of makeClient(fetchFn as typeof fetch).fetchHashtagMedia('h1', 'recent_media', 3)) {
      pages.push(page.map((m) => m.id));
    }
    expect(pages).toEqual([['1', '2'], ['3']]);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    const secondUrl = new URL(fetchFn.mock.calls[1][0] as string);
    expect(secondUrl.searchParams.get('after')).toBe('A');
    expect(secondUrl.searchParams.get('limit')).toBe('1');
  });

  it('stops when there is no next page', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ data: [media('1')] }));
    const pages = [];
    for await (const p of makeClient(fetchFn as typeof fetch).fetchHashtagMedia('h1', 'top_media', 100)) {
      pages.push(p);
    }
    expect(pages).toHaveLength(1);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('retries 500 then succeeds', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(new Response('boom', { status: 500 }))
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: 'h1' }] }));
    await expect(makeClient(fetchFn as typeof fetch).searchHashtag('x')).resolves.toBe('h1');
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('does not retry 400 and throws MetaApiError', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response('bad token', { status: 400 }));
    await expect(makeClient(fetchFn as typeof fetch).searchHashtag('x')).rejects.toThrow(MetaApiError);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('gives up after 3 attempts on persistent 500', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response('boom', { status: 500 }));
    await expect(makeClient(fetchFn as typeof fetch).searchHashtag('x')).rejects.toThrow(MetaApiError);
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });
});
