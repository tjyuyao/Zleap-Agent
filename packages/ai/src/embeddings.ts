/**
 * Minimal embeddings client for OpenAI-compatible `/embeddings` endpoints and
 * multimodal `/embeddings/multimodal` endpoints (Volces Ark doubao-embedding-vision,
 * text content only), plus a deterministic offline embedder for tests and for
 * running without an embedding endpoint configured. Kept dependency-free (fetch only).
 */

export type EmbedRequest = {
  baseUrl: string;
  /** Optional for local runtimes (Ollama/vLLM); auth header attaches only when set. */
  apiKey?: string;
  model: string;
  input: string[];
  /**
   * Endpoint flavor. `multimodal` targets `/embeddings/multimodal` (e.g. Volces
   * Ark doubao-embedding-vision) and wraps each text as a `{ type: 'text' }`
   * content object; `text` (default) uses the OpenAI-compatible `/embeddings`.
   */
  mode?: 'text' | 'multimodal';
  signal?: AbortSignal;
};

export type EmbedResult = {
  embeddings: number[][];
  model: string;
};

type OpenAiEmbeddingResponse = {
  data?: Array<{ embedding: number[]; index: number }>;
  model?: string;
};

/** Ark multimodal response: `data` is a single `{ embedding: [...] }` object. */
type MultimodalEmbeddingResponse = {
  data?: { embedding: number[] };
  model?: string;
};

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

async function postEmbedding(
  url: string,
  model: string,
  input: unknown,
  signal?: AbortSignal,
  /** Optional: local runtimes (Ollama/vLLM) need no auth. */
  apiKey?: string,
): Promise<Response> {
  // Local embedding runtimes need no auth: attach the header only when a key is set.
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  const response = await fetch(url, {
    method: 'POST',
    signal,
    headers,
    body: JSON.stringify({ model, input }),
  });
  if (!response.ok) {
    throw new Error(`embed: HTTP ${response.status}: ${await response.text()}`);
  }
  return response;
}

function embeddingsFromResponse(json: unknown, model: string): EmbedResult {
  if (json && typeof json === 'object') {
    const body = json as { data?: unknown; model?: unknown };
    if (Array.isArray(body.data)) {
      const rows = (body.data as Array<{ embedding?: number[]; index?: number }>)
        .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
        .map((row) => row.embedding ?? []);
      return { embeddings: rows, model: typeof body.model === 'string' ? body.model : model };
    }
    if (body.data && typeof body.data === 'object') {
      const embedding = (body.data as { embedding?: number[] }).embedding;
      if (Array.isArray(embedding)) {
        return { embeddings: [embedding], model: typeof body.model === 'string' ? body.model : model };
      }
    }
  }
  throw new Error('embed: unexpected response shape');
}

/** Call an embeddings endpoint (OpenAI-compatible or multimodal). Throws on HTTP/parse errors. */
export async function embed(request: EmbedRequest): Promise<EmbedResult> {
  if (!request.baseUrl) {
    throw new Error('embed: baseUrl is required');
  }
  // apiKey is optional: local runtimes (Ollama/vLLM) have no auth, so only
  // baseUrl is strictly required; the header attaches only when a key is set.
  if (request.input.length === 0) {
    return { embeddings: [], model: request.model };
  }

  const baseUrl = normalizeBaseUrl(request.baseUrl);
  if (request.mode === 'multimodal') {
    // Ark /embeddings/multimodal merges the whole `input` array into a single
    // vector, so vectorize each text with its own request to keep 1:1 mapping.
    const results = await Promise.all(
      request.input.map(async (text) => {
        const response = await postEmbedding(
          `${baseUrl}/embeddings/multimodal`,
          request.model,
          [{ type: 'text', text }],
          request.signal,
          request.apiKey,
        );
        return embeddingsFromResponse(await response.json(), request.model);
      }),
    );
    return { embeddings: results.flatMap((result) => result.embeddings), model: request.model };
  }

  const response = await postEmbedding(
    `${baseUrl}/embeddings`,
    request.model,
    request.input,
    request.signal,
    request.apiKey,
  );
  return embeddingsFromResponse(await response.json(), request.model);
}

/**
 * Deterministic, dependency-free embedding for offline use and tests. Hashes
 * tokens into `dim` buckets and L2-normalizes — similar texts share buckets, so
 * cosine similarity is meaningful enough to exercise recall ordering.
 */
export function fauxEmbed(text: string, dim = 64): number[] {
  const vector = new Array<number>(dim).fill(0);
  const tokens = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  for (const token of tokens) {
    let hash = 2166136261;
    for (let i = 0; i < token.length; i += 1) {
      hash ^= token.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    const bucket = Math.abs(hash) % dim;
    vector[bucket] += 1;
  }
  return l2normalize(vector);
}

export function l2normalize(vector: number[]): number[] {
  let sum = 0;
  for (const value of vector) {
    sum += value * value;
  }
  const norm = Math.sqrt(sum);
  if (norm === 0) {
    return vector;
  }
  return vector.map((value) => value / norm);
}

/** Cosine similarity of two equal-length vectors (1 = identical direction). */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) {
    return 0;
  }
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) {
    return 0;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
