import type { ModelConfigRecord } from '@zleap/core';
import { describe, expect, it } from 'vitest';
import { upsertDefault302ModelConfigs } from '../lib/server/modelPresets';

describe('302 model presets', () => {
  it('creates default 302 llm and embedding configs with the shared key', async () => {
    const saved: ModelConfigRecord[] = [];
    // Explicit (empty) tombstone keeps this unit hermetic: no 302 config read.
    const models = await upsertDefault302ModelConfigs(makeStore([], saved), { apiKey: 'test-key', removedModelIds: new Set<string>() });

    expect(models.map((model) => model.id)).toEqual(expect.arrayContaining(['302-qwen3-6-flash', '302-qwen3-embedding-0-6b']));
    expect(saved).toHaveLength(2);
    expect(saved).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: '302-qwen3-6-flash',
          model: 'qwen3.6-flash',
          purpose: 'main',
          config: expect.objectContaining({ apiKey: 'test-key', isDefault: true, providerKey: '302ai' }),
        }),
        expect.objectContaining({
          id: '302-qwen3-embedding-0-6b',
          model: 'Qwen/Qwen3-Embedding-0.6B',
          purpose: 'embedding',
          config: expect.objectContaining({ apiKey: 'test-key', isDefault: true, providerKey: '302ai' }),
        }),
      ]),
    );
  });

  it('keeps a user-deleted built-in model deleted (tombstone)', async () => {
    // Mirrors the UI bug: delete `302-qwen3-6-flash`, then the next list refresh calls
    // `upsertDefault302ModelConfigs`. The tombstone must stop the resurrection.
    const saved: ModelConfigRecord[] = [];
    const models = await upsertDefault302ModelConfigs(
      makeStore([], saved),
      { apiKey: 'test-key', removedModelIds: new Set(['302-qwen3-6-flash']) },
    );

    expect(models.map((model) => model.id)).not.toContain('302-qwen3-6-flash');
    expect(models.map((model) => model.id)).toContain('302-qwen3-embedding-0-6b');
    // The deleted preset must not be persisted back to the store either.
    expect(saved.map((model) => model.id)).not.toContain('302-qwen3-6-flash');
  });

  it('still re-creates a never-present built-in model when no tombstone exists', async () => {
    const saved: ModelConfigRecord[] = [];
    const models = await upsertDefault302ModelConfigs(
      makeStore([], saved),
      { apiKey: 'test-key', removedModelIds: new Set<string>() },
    );

    // Fresh state (nothing deleted) still seeds both presets.
    expect(models.map((model) => model.id)).toEqual(
      expect.arrayContaining(['302-qwen3-6-flash', '302-qwen3-embedding-0-6b']),
    );
    expect(saved).toHaveLength(2);
  });

  it('does not steal defaults from existing user models', async () => {
    const now = new Date('2026-01-01T00:00:00Z');
    const existing: ModelConfigRecord[] = [
      {
        id: 'custom-llm',
        providerId: 'openai-compatible',
        model: 'custom',
        purpose: 'main',
        config: { isDefault: true },
        createdAt: now,
        updatedAt: now,
      },
    ];
    const saved: ModelConfigRecord[] = [];
    const models = await upsertDefault302ModelConfigs(makeStore(existing, saved), { apiKey: 'test-key' });

    const qwen = models.find((model) => model.id === '302-qwen3-6-flash');
    const embedding = models.find((model) => model.id === '302-qwen3-embedding-0-6b');
    expect(qwen?.config?.isDefault).toBe(false);
    expect(embedding?.config?.isDefault).toBe(true);
  });
});

function makeStore(existing: ModelConfigRecord[], saved: ModelConfigRecord[]) {
  return {
    models: {
      listModelConfigs: async () => existing,
      getModelConfig: async (id: string) => existing.find((model) => model.id === id),
      saveModelConfig: async (record: ModelConfigRecord) => {
        saved.push(record);
      },
      deleteModelConfig: async () => undefined,
    },
  };
}
