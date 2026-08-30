import { describe, expect, it, vi } from 'vitest';
import { embed } from '../src/embeddings.js';

function captureFetch() {
  const urls: string[] = [];
  const bodies: Record<string, unknown>[] = [];
  return { urls, bodies };
}

function stubFetch(textMode: boolean, status = 200) {
  const { urls, bodies } = captureFetch();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: { body: string }) => {
      urls.push(String(url));
      bodies.push(JSON.parse(init.body) as Record<string, unknown>);
      const data = textMode
        ? [
            { index: 1, embedding: [0.2] },
            { index: 0, embedding: [0.1] },
          ]
        : { embedding: [0.3] };
      return new Response(JSON.stringify({ model: 'm', data }), { status });
    }),
  );
  return { urls, bodies };
}

describe('embed client', () => {
  it('posts to /embeddings with a plain string array in text mode', async () => {
    const { urls, bodies } = stubFetch(true);

    const result = await embed({ baseUrl: 'https://example.test/v1/', apiKey: 'k', model: 'm', input: ['a', 'b'] });
    vi.unstubAllGlobals();

    expect(urls).toEqual(['https://example.test/v1/embeddings']);
    expect(bodies[0]).toEqual({ model: 'm', input: ['a', 'b'] });
    // rows sorted by index
    expect(result).toEqual({ embeddings: [[0.1], [0.2]], model: 'm' });
  });

  it('posts one /embeddings/multimodal request per text and parses the single-object data shape', async () => {
    const { urls, bodies } = stubFetch(false);

    const result = await embed({
      baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      apiKey: 'k',
      model: 'doubao-embedding-vision-251215',
      input: ['天很蓝，海很深', 'second'],
      mode: 'multimodal',
    });
    vi.unstubAllGlobals();

    expect(urls).toEqual([
      'https://ark.cn-beijing.volces.com/api/v3/embeddings/multimodal',
      'https://ark.cn-beijing.volces.com/api/v3/embeddings/multimodal',
    ]);
    expect(bodies[0]).toEqual({
      model: 'doubao-embedding-vision-251215',
      input: [{ type: 'text', text: '天很蓝，海很深' }],
    });
    expect(bodies[1]).toEqual({
      model: 'doubao-embedding-vision-251215',
      input: [{ type: 'text', text: 'second' }],
    });
    expect(result.embeddings).toEqual([[0.3], [0.3]]);
  });

  it('throws on an unexpected response shape', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })));
    await expect(embed({ baseUrl: 'https://example.test/v1', apiKey: 'k', model: 'm', input: ['a'] })).rejects.toThrow(
      'unexpected response shape',
    );
    vi.unstubAllGlobals();
  });

  it('short-circuits empty input without fetching', async () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    const result = await embed({
      baseUrl: 'https://example.test/v1',
      apiKey: 'k',
      model: 'm',
      input: [],
      mode: 'multimodal',
    });
    vi.unstubAllGlobals();

    expect(spy).not.toHaveBeenCalled();
    expect(result).toEqual({ embeddings: [], model: 'm' });
  });
});
