import { storeFromEnv } from '../../../../lib/server/avatarStore';
import { isActorResponse, requireHttpActor } from '../../../../lib/server/actor';
import { getFileModelConfig } from '../../../../lib/server/modelConfigFileStore';
import { modelKind } from '../../../../lib/models';
import { DEFAULT_302_MODEL_BASE_URL, read302IntegrationConfig, resolve302ApiKey } from '../../../../lib/server/integration302Config';
import { upsertDefault302ModelConfigs } from '../../../../lib/server/modelPresets';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  const actor = requireHttpActor(req, { roles: ['admin'] });
  if (isActorResponse(actor)) return actor;
  const store = await storeFromEnv();
  try {
    const body = (await req.json()) as { id?: string };
    if (!body.id?.trim()) {
      return Response.json({ error: 'id_required' }, { status: 400 });
    }
    await upsertDefault302ModelConfigs(store);
    const model = store ? await store.models.getModelConfig(body.id.trim()) : await getFileModelConfig(body.id.trim());
    if (!model) {
      return Response.json({ error: 'model_not_found' }, { status: 404 });
    }
    const config = model.config ?? {};
    const integration302 = is302Config(config) ? await read302IntegrationConfig() : {};
    const baseUrl =
      stringValue(config.baseUrl) ??
      (is302Config(config) ? DEFAULT_302_MODEL_BASE_URL : undefined) ??
      process.env.ZLEAP_MODEL_BASE_URL ??
      process.env.LLM_BASE_URL;
    // apiKey is optional: local runtimes (Ollama/vLLM/llama.cpp) have no auth, so
    // only baseUrl is strictly required; the key attaches only when present.
    const apiKey = stringValue(config.apiKey) ?? (is302Config(config) ? resolve302ApiKey(integration302) : undefined) ?? process.env.ZLEAP_MODEL_API_KEY ?? process.env.LLM_API_KEY;
    if (!baseUrl) {
      return Response.json({ error: 'model_base_url_required' }, { status: 400 });
    }
    const protocol = modelProtocol(model.providerId, config.protocol);
    const response =
      modelKind(model) === 'embedding'
        ? await fetch(
            `${normalizeBaseUrl(baseUrl)}${config.embeddingMode === 'multimodal' ? '/embeddings/multimodal' : '/embeddings'}`,
            {
              method: 'POST',
              headers: openAiAuthHeaders(apiKey),
              body: JSON.stringify({
                model: model.model,
                input: config.embeddingMode === 'multimodal' ? [{ type: 'text', text: 'ok' }] : ['ok'],
              }),
            },
          )
        : protocol === 'anthropic'
        ? await fetch(`${normalizeBaseUrl(baseUrl)}/messages`, {
            method: 'POST',
            headers: anthropicAuthHeaders(apiKey),
            body: JSON.stringify({
              model: model.model,
              messages: [{ role: 'user', content: 'Reply with ok.' }],
              max_tokens: 8,
              temperature: 0,
            }),
          })
        : await fetch(`${normalizeBaseUrl(baseUrl)}/chat/completions`, {
            method: 'POST',
            headers: openAiAuthHeaders(apiKey),
            body: JSON.stringify({
              model: model.model,
              messages: [{ role: 'user', content: 'Reply with ok.' }],
              max_tokens: 8,
              temperature: 0,
            }),
          });
    if (!response.ok) {
      // Inline a concise excerpt of the server's response body into the
      // error string (the `postJson` → toast path only carries `error`), so the
      // UI can show the real reason, e.g. 404 "The model `x` does not exist".
      const detail = (await response.text()).trim();
      const excerpt = detail.length > 200 ? `${detail.slice(0, 200)}…` : detail;
      return Response.json(
        { error: `model_test_failed:${response.status}${excerpt ? ` ${excerpt}` : ''}`, detail },
        { status: 400 },
      );
    }
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  } finally {
    await store?.close().catch(() => {});
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function is302Config(config: Record<string, unknown>): boolean {
  return stringValue(config.providerKey) === '302ai';
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, '');
}

function modelProtocol(providerId: string, protocol: unknown): 'openai' | 'anthropic' {
  if (protocol === 'anthropic' || providerId === 'anthropic') {
    return 'anthropic';
  }
  return 'openai';
}

/** OpenAI-compatible auth headers; local runtimes need no auth, so attach the
 *  key only when present (avoids sending a meaningless `Bearer undefined`). */
function openAiAuthHeaders(apiKey: string | undefined): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (apiKey) {
    headers.authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

/** Anthropic auth headers; same optional-key rule as the OpenAI-compatible ones. */
function anthropicAuthHeaders(apiKey: string | undefined): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' };
  if (apiKey) {
    headers['x-api-key'] = apiKey;
  }
  return headers;
}
