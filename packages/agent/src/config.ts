export type EmbeddingConfig = {
  model: string;
  baseUrl?: string;
  apiKey?: string;
  dimension?: number;
  /** Endpoint flavor: 'multimodal' uses /embeddings/multimodal (e.g. doubao-embedding-vision). */
  mode?: 'text' | 'multimodal';
};

export type PersistenceConfig = {
  databaseUrl?: string;
  embedding?: EmbeddingConfig;
};
