import { embed, fauxEmbed } from '@zleap/ai';
import { createStore, type Embedder, type StoreConfig, type ZleapStore } from '@zleap/store';

const DEFAULT_EMBED_DIM = 1536;
const FAUX_EMBED_DIM = 64;

export async function storeFromEnv(): Promise<ZleapStore | null> {
  const config = storeConfigFromEnv();
  return config ? createStore(config) : null;
}

export function storeConfigFromEnv(): StoreConfig | null {
  const databaseUrl = process.env.ZLEAP_DATABASE_URL;
  if (!databaseUrl) {
    return null;
  }
  const embeddingModel = process.env.ZLEAP_EMBED_MODEL;
  const baseUrl = process.env.ZLEAP_EMBED_BASE_URL ?? process.env.ZLEAP_MODEL_BASE_URL ?? process.env.LLM_BASE_URL;
  const apiKey = process.env.ZLEAP_EMBED_API_KEY ?? process.env.ZLEAP_MODEL_API_KEY ?? process.env.LLM_API_KEY;
  // apiKey is optional for local embedding runtimes (Ollama/vLLM): a
  // real embedder is used when model + baseUrl are set, key or not.
  const useReal = Boolean(embeddingModel && baseUrl);
  const dimension = process.env.ZLEAP_EMBED_DIM
    ? Number(process.env.ZLEAP_EMBED_DIM)
    : useReal
      ? DEFAULT_EMBED_DIM
      : FAUX_EMBED_DIM;
  const mode = process.env.ZLEAP_EMBED_MODE?.trim() === 'multimodal' ? 'multimodal' : undefined;
  const embedder: Embedder = useReal
    ? async (texts) =>
        (await embed({ baseUrl: baseUrl!, apiKey: apiKey!, model: embeddingModel!, input: texts, mode })).embeddings
    : async (texts) => texts.map((text) => fauxEmbed(text, dimension));
  return { connectionString: databaseUrl, dimension, embed: embedder };
}
