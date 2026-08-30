import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DELETE as DELETE_MODELS, GET as GET_MODELS, POST as POST_MODELS } from '../app/api/models/route';
import { storeFromEnv } from '../lib/server/avatarStore';
import { getSharedStore } from '../lib/server/sharedStore';

vi.mock('../lib/server/sharedStore', () => ({
  getSharedStore: vi.fn(),
}));

vi.mock('../lib/server/avatarStore', () => ({
  storeFromEnv: vi.fn(),
}));

vi.mock('../lib/server/avatarContext', () => ({
  avatarErrorResponse: (error: unknown) =>
    Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 }),
  createModelConfig: vi.fn(),
  ensureAvatar: vi.fn(async () => {}),
}));

const getSharedStoreMock = vi.mocked(getSharedStore);
const storeFromEnvMock = vi.mocked(storeFromEnv);

/**
 * Regression for “clicking delete on the model page does nothing”: the delete
 * request itself succeeded, but the UI’s `resources.reload()` (exactly this GET) ran
 * `upsertDefault302ModelConfigs`, which re-created any missing built-in 302 preset.
 * Deleting a preset now writes a tombstone; the list must not resurrect it.
 */
describe('/api/models delete + list (built-in preset tombstone)', () => {
  let tempDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    // No shared DB and no request store: both the 302 config and the model configs
    // are file-backed at the env-pointed temp paths below.
    getSharedStoreMock.mockResolvedValue(null);
    storeFromEnvMock.mockResolvedValue(null);
    tempDir = await mkTempDir();
    vi.stubEnv('ZLEAP_AUTH_MODE', 'dev-header');
    vi.stubEnv('ZLEAP_WEB_MODEL_CONFIG_PATH', join(tempDir, 'web-models.json'));
    vi.stubEnv('ZLEAP_302_CONFIG_PATH', join(tempDir, '302.json'));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(tempDir, { recursive: true, force: true });
  });

  it('deletes a built-in 302 model and the list reload does not resurrect it', async () => {
    const initial = await GET_MODELS(adminRequest('/api/models', 'GET'));
    await expectStatus(initial, 200);
    const firstModels = (await initial.json()) as { models: Array<{ id: string }> };
    // First list seeds the two built-in presets.
    expect(firstModels.models.map((model) => model.id)).toEqual(
      expect.arrayContaining(['302-qwen3-6-flash', '302-qwen3-embedding-0-6b']),
    );

    const deleted = await DELETE_MODELS(
      adminRequest('/api/models', 'DELETE', { id: '302-qwen3-6-flash' }),
    );
    await expectStatus(deleted, 200);
    await expect(deleted.json()).resolves.toMatchObject({ ok: true });

    // The tombstone is recorded in the 302 integration config.
    const configRaw = await readFile(join(tempDir, '302.json'), 'utf8');
    const config = JSON.parse(configRaw) as { removedModelIds?: string[] };
    expect(config.removedModelIds).toEqual(expect.arrayContaining(['302-qwen3-6-flash']));

    // The UI’s `resources.reload()` after a successful delete performs exactly
    // this request; the deleted built-in model must not come back with the list.
    const relisted = await GET_MODELS(adminRequest('/api/models', 'GET'));
    await expectStatus(relisted, 200);
    const finalModels = (await relisted.json()) as { models: Array<{ id: string }> };
    expect(finalModels.models.map((model) => model.id)).not.toContain('302-qwen3-6-flash');
    expect(finalModels.models.map((model) => model.id)).toContain('302-qwen3-embedding-0-6b');
  });

  it('deleting a custom model does not write a preset tombstone', async () => {
    const created = await POST_MODELS(
      adminRequest('/api/models', 'POST', { id: 'custom-llm', model: 'gpt-custom' }),
    );
    await expectStatus(created, 201);

    const deleted = await DELETE_MODELS(
      adminRequest('/api/models', 'DELETE', { id: 'custom-llm' }),
    );
    await expectStatus(deleted, 200);
    await expect(deleted.json()).resolves.toMatchObject({ ok: true });

    // `custom-llm` is not a built-in preset: no tombstone is recorded in the 302 config.
    const configRaw = await readFile(join(tempDir, '302.json'), 'utf8').catch(() => '');
    const config = configRaw ? (JSON.parse(configRaw) as { removedModelIds?: string[] }) : {};
    expect(config.removedModelIds ?? []).toEqual([]);

    // And the custom model is actually gone (the delete itself works).
    const modelsRaw = await readFile(join(tempDir, 'web-models.json'), 'utf8');
    const models = JSON.parse(modelsRaw) as Array<{ id: string }>;
    expect(models.map((model) => model.id)).not.toContain('custom-llm');
  });
});

async function mkTempDir(): Promise<string> {
  const dir = join(tmpdir(), `zleap-models-delete-route-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

function adminRequest(path: string, method: string, body?: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-zleap-user-id': 'local-dev-user',
      'x-zleap-actor-role': 'admin',
      'x-zleap-tenant-id': 'local-dev',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function expectStatus(response: Response, status: number): Promise<void> {
  if (response.status !== status) {
    throw new Error(`expected status ${status}, got ${response.status}: ${await response.clone().text()}`);
  }
}
