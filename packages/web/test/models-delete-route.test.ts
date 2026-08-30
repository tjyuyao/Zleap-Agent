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
 * Models are purely user-managed (no built-in 302 presets, no tombstones): a
 * deleted model must stay deleted across list reloads, and deleting one must
 * not write any side-channel state (e.g. the 302 integration config).
 */
describe('/api/models delete + list (pure user management)', () => {
  let tempDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
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

  it('a deleted model stays gone after the list reload (no resurrection)', async () => {
    const created = await POST_MODELS(
      adminRequest('/api/models', 'POST', { id: 'custom-llm', model: 'gpt-custom' }),
    );
    await expectStatus(created, 201);

    const listed = await GET_MODELS(adminRequest('/api/models', 'GET'));
    await expectStatus(listed, 200);
    const before = ((await listed.json()) as { models: Array<{ id: string }> }).models;
    expect(before.map((model) => model.id)).toContain('custom-llm');

    const deleted = await DELETE_MODELS(
      adminRequest('/api/models', 'DELETE', { id: 'custom-llm' }),
    );
    await expectStatus(deleted, 200);

    // The UI’s `resources.reload()` after a successful delete performs exactly
    // this GET; the deleted model must not come back.
    const relisted = await GET_MODELS(adminRequest('/api/models', 'GET'));
    await expectStatus(relisted, 200);
    const after = ((await relisted.json()) as { models: Array<{ id: string }> }).models;
    expect(after.map((model) => model.id)).not.toContain('custom-llm');
  });

  it('deleting a model that does not exist returns 404', async () => {
    const deleted = await DELETE_MODELS(
      adminRequest('/api/models', 'DELETE', { id: 'missing-model' }),
    );
    await expectStatus(deleted, 404);
  });

  it('deleting a model does not write the 302 integration config file', async () => {
    await POST_MODELS(adminRequest('/api/models', 'POST', { id: 'custom-llm', model: 'gpt-custom' }));
    await DELETE_MODELS(adminRequest('/api/models', 'DELETE', { id: 'custom-llm' }));

    const configRaw = await readFile(join(tempDir, '302.json'), 'utf8').catch(() => '');
    expect(configRaw).toBe('');
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
