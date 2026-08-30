import type { CustomModelConfig } from '@zleap/ai';
import { toCanonicalSpaceId, type ModelConfigRecord } from '@zleap/core';
import type { ZleapStore } from '@zleap/store';
import { read302IntegrationConfig, resolve302ApiKey, resolve302ModelBaseUrl } from '../integration302.js';

/**
 * Server-side model resolution, converged from the duplicated web/worker logic.
 * Resolution order: explicit model config id -> target space's model -> the
 * configured default -> environment fallback. Returns `undefined` only when no
 * runnable model can be found anywhere.
 */
export type ResolveModelInput = {
  modelConfigId?: string;
  targetSpace?: string;
};

export type ModelResolution = {
  model?: CustomModelConfig;
  source: 'config' | 'space' | 'default' | 'env' | 'none';
  modelId?: string;
};

export async function resolveModelFromStore(
  store: ZleapStore | null,
  input: ResolveModelInput = {},
): Promise<ModelResolution> {
  if (store && input.modelConfigId) {
    const record = await store.models.getModelConfig(input.modelConfigId);
    const model = record ? await toEngineModelResolved(record) : undefined;
    if (model) {
      return { model, source: 'config', modelId: record!.id };
    }
  }

  if (store && input.targetSpace) {
    const spaceModelId = await modelConfigIdFromSpace(store, input.targetSpace);
    if (spaceModelId) {
      const record = await store.models.getModelConfig(spaceModelId);
      const model = record ? await toEngineModelResolved(record) : undefined;
      if (model) {
        return { model, source: 'space', modelId: record!.id };
      }
    }
  }

  if (store) {
    const configs = await store.models.listModelConfigs();
    const defaultRecord = configs.find(
      (record) => record.purpose !== 'embedding' && record.config?.isDefault === true,
    ) ?? (await store.models.listModelConfigs({ purpose: 'main' })).find(
      (record) => record.purpose !== 'embedding',
    );
    const defaultModel = defaultRecord ? await toEngineModelResolved(defaultRecord) : undefined;
    if (defaultModel) {
      return { model: defaultModel, source: 'default', modelId: defaultRecord!.id };
    }
  }

  const envModel = modelFromEnv();
  return envModel
    ? { model: envModel, source: 'env', modelId: envModel.id }
    : { source: 'none' };
}

export function modelFromEnv(): CustomModelConfig | undefined {
  const baseUrl = process.env.ZLEAP_MODEL_BASE_URL ?? process.env.LLM_BASE_URL;
  const apiKey = process.env.ZLEAP_MODEL_API_KEY ?? process.env.LLM_API_KEY;
  const model = process.env.ZLEAP_MODEL_NAME ?? process.env.LLM_MODEL;
  // apiKey is optional: local runtimes (Ollama/vLLM) need no auth, so only
  // baseUrl + model are strictly required for an env-configured model.
  if (!baseUrl || !model) {
    return undefined;
  }
  return { baseUrl, apiKey, model, id: model, displayName: model };
}

export async function toEngineModelResolved(record: ModelConfigRecord): Promise<CustomModelConfig | undefined> {
  const config = (record.config ?? {}) as Record<string, unknown>;
  if (!is302Config(config)) {
    return toEngineModel(record);
  }
  const integration302 = await read302IntegrationConfig();
  return toEngineModel(record, {
    baseUrl: resolve302ModelBaseUrl(integration302),
    apiKey: resolve302ApiKey(integration302),
  });
}

export function toEngineModel(record: ModelConfigRecord, fallback: { baseUrl?: string; apiKey?: string } = {}): CustomModelConfig | undefined {
  if (record.purpose === 'embedding') {
    return undefined;
  }
  const config = (record.config ?? {}) as Record<string, unknown>;
  const is302 = is302Config(config);
  const baseUrl = stringConfig(config, 'baseUrl') ?? stringConfig(config, 'baseURL')
    ?? (is302 ? fallback.baseUrl ?? resolve302ModelBaseUrl() : undefined)
    ?? process.env.ZLEAP_MODEL_BASE_URL ?? process.env.LLM_BASE_URL;
  const apiKey = stringConfig(config, 'apiKey')
    ?? (is302 ? fallback.apiKey ?? resolve302ApiKey() : undefined)
    ?? process.env.ZLEAP_MODEL_API_KEY ?? process.env.LLM_API_KEY;
  // apiKey is optional for local runtimes (no auth needed); only baseUrl
  // is strictly required. Providers attach the auth header only when set.
  if (!baseUrl) {
    return undefined;
  }
  return {
    protocol: record.providerId === 'anthropic' || stringConfig(config, 'protocol') === 'anthropic' ? 'anthropic' : 'openai',
    baseUrl,
    apiKey,
    model: record.model,
    id: record.id,
    displayName: stringConfig(config, 'displayName') ?? record.id,
    contextWindow: numberConfig(config, 'contextWindow'),
    maxOutputTokens: numberConfig(config, 'maxOutputTokens'),
    supportsTools: booleanConfig(config, 'supportsTools'),
    supportsThinking: booleanConfig(config, 'supportsThinking'),
    supportsCache: booleanConfig(config, 'supportsCache'),
    tokenizer: stringConfig(config, 'tokenizer'),
    reasoningEffort: stringConfig(config, 'reasoningEffort') as CustomModelConfig['reasoningEffort'],
  };
}

function is302Config(config: Record<string, unknown>): boolean {
  return stringConfig(config, 'providerKey') === '302ai';
}

async function modelConfigIdFromSpace(store: ZleapStore, targetSpace: string): Promise<string | undefined> {
  const rawSpaceId = targetSpace.trim();
  if (!rawSpaceId) {
    return undefined;
  }
  try {
    const space = await store.spaces.getSpace(toCanonicalSpaceId(rawSpaceId));
    if (!space) {
      return undefined;
    }
    const version = await store.spaces.getSpaceVersion(space.id, space.currentVersion);
    return version?.modelConfigId?.trim() || undefined;
  } catch {
    return undefined;
  }
}

function stringConfig(config: Record<string, unknown>, key: string): string | undefined {
  const value = config[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function numberConfig(config: Record<string, unknown>, key: string): number | undefined {
  const value = config[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function booleanConfig(config: Record<string, unknown>, key: string): boolean | undefined {
  const value = config[key];
  return typeof value === 'boolean' ? value : undefined;
}
