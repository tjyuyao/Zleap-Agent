'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import { slugify } from '@/lib/utils';
import { postJson, patchJson } from '@/lib/api';
import type { ModelConfigView } from '@/lib/useResources';
import { modelKind, type ModelKind } from '@/lib/models';
import { Plus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ManageDialog, ManageDialogFooterActions, ManageField, ManageForm, ManagePreviewBlock } from './manage-ui';

/** A named reasoning-effort preset (variant) the user can switch between. */
type VariantRow = { key: string; label: string; effort: string };

/** Non-empty stand-in for "no override" — Radix reserves "" for the unselected/placeholder state. */
const DEFAULT_EFFORT_KEY = 'default';

type ModelDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  avatarId?: string;
  /** When set, the dialog edits this model instead of creating a new one. */
  editTarget?: ModelConfigView | null;
  onSaved: () => void;
};

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

const MODEL_PROVIDERS = [
  { id: '302ai', label: '302', protocol: 'openai', providerId: 'openai-compatible', baseUrl: 'https://api.302.ai/v1' },
  { id: 'custom', label: 'Custom', protocol: 'openai', providerId: 'openai-compatible', baseUrl: '' },
] as const;
const MODEL_PROTOCOLS = ['openai', 'anthropic'] as const;
const DEFAULT_PROVIDER = MODEL_PROVIDERS[0];
const CUSTOM_PROVIDER = MODEL_PROVIDERS[1];

/** Create or edit a global model config. New configs become the default for their kind. */
export function ModelDialog({ open, onOpenChange, avatarId, editTarget, onSaved }: ModelDialogProps) {
  const { t } = useTranslation();
  const editing = Boolean(editTarget);
  const [kind, setKind] = useState<ModelKind>('llm');
  const [name, setName] = useState('');
  const [providerId, setProviderId] = useState<(typeof MODEL_PROVIDERS)[number]['id']>(DEFAULT_PROVIDER.id);
  const [protocol, setProtocol] = useState<(typeof MODEL_PROTOCOLS)[number]>('openai');
  const [model, setModel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [contextWindow, setContextWindow] = useState('');
  const [maxOutput, setMaxOutput] = useState('');
  const [embeddingMode, setEmbeddingMode] = useState<'text' | 'multimodal'>('text');
  const [embeddingDimension, setEmbeddingDimension] = useState('');
  /** Reasoning-effort presets (variants) this model declares — editable for LLMs. */
  const [variantRows, setVariantRows] = useState<VariantRow[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (editTarget) {
      const c = editTarget.config ?? {};
      const pk = str(c.providerKey);
      const provider = MODEL_PROVIDERS.find((p) => p.id === pk) ?? CUSTOM_PROVIDER;
      setKind(modelKind(editTarget));
      setName(str(c.displayName));
      setProviderId(provider.id);
      setProtocol((str(c.protocol) as (typeof MODEL_PROTOCOLS)[number]) || (editTarget.providerId === 'anthropic' ? 'anthropic' : 'openai'));
      setModel(editTarget.model);
      setBaseUrl(str(c.baseUrl));
      setApiKey('');
      setContextWindow(c.contextWindow != null ? String(c.contextWindow) : '');
      setMaxOutput(c.maxOutputTokens != null ? String(c.maxOutputTokens) : '');
      setEmbeddingMode(c.embeddingMode === 'multimodal' ? 'multimodal' : 'text');
      setEmbeddingDimension(c.embeddingDimension != null ? String(c.embeddingDimension) : '');
      setVariantRows(readVariantRows(c.variants));
      return;
    }
    setKind('llm');
    setName('');
    setProviderId(DEFAULT_PROVIDER.id);
    setProtocol(DEFAULT_PROVIDER.protocol);
    setModel('');
    setBaseUrl(DEFAULT_PROVIDER.baseUrl);
    setApiKey('');
    setContextWindow('');
    setMaxOutput('');
    setEmbeddingMode('text');
    setEmbeddingDimension('');
    setVariantRows([]);
  }, [open, editTarget]);

  const changeProvider = (value: string) => {
    const next = MODEL_PROVIDERS.find((provider) => provider.id === value) ?? DEFAULT_PROVIDER;
    setProviderId(next.id);
    setProtocol(next.protocol);
    if (next.baseUrl) {
      setBaseUrl(next.baseUrl);
    } else if (value !== 'custom') {
      setBaseUrl('');
    }
  };

  const addVariantRow = () => setVariantRows((rows) => [...rows, { key: '', label: '', effort: '' }]);
  const removeVariantRow = (index: number) => setVariantRows((rows) => rows.filter((_, i) => i !== index));
  const updateVariantRow = (index: number, patch: Partial<VariantRow>) =>
    setVariantRows((rows) => rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));

  const submit = async () => {
    const id = editing ? editTarget!.id : slugify(name || model);
    // The API key is only required for cloud APIs: local runtimes (Ollama,
    // vLLM, …) have none. On edit a blank key keeps the stored one.
    if (!id || !model.trim() || !baseUrl.trim()) {
      toast.error(t('model.validation', { defaultValue: 'Model and Base URL are required. (API key only for cloud APIs.)' }));
      return;
    }
    // A preset row that carries a label or effort but no ID (key) would be
    // silently dropped by `buildVariantsConfig` — surface it instead of saving
    // a preset the user thinks they configured.
    const incompleteVariant = variantRows.find((row) => !row.key.trim() && (row.label.trim() || row.effort));
    if (incompleteVariant) {
      toast.error(t('model.variantKeyRequired', { defaultValue: 'Each reasoning-effort preset needs an ID (key) — please fill it in or remove the preset.' }));
      return;
    }
    const provider = MODEL_PROVIDERS.find((candidate) => candidate.id === providerId) ?? DEFAULT_PROVIDER;
    const resolvedProviderId = protocol === 'anthropic' ? 'anthropic' : provider.providerId;
    const config = compact({
      displayName: name.trim() || undefined,
      providerKey: provider.id,
      baseUrl: baseUrl.trim() || undefined,
      apiKey: apiKey.trim() || undefined,
      protocol,
      contextWindow: numeric(contextWindow),
      maxOutputTokens: numeric(maxOutput),
    });
    if (config && kind === 'embedding') {
      // Explicit values so an edit can clear a previously saved mode/dimension
      // (PATCH merges the submitted config over the stored one).
      config.embeddingMode = embeddingMode;
      config.embeddingDimension = numeric(embeddingDimension) ?? null;
    }
    if (config && kind === 'llm') {
      // Drop empty rows; always write the (possibly empty) set so an edit can clear.
      config.variants = buildVariantsConfig(variantRows);
    }
    setBusy(true);
    try {
      if (editing) {
        await patchJson('/api/models', { id, kind, providerId: resolvedProviderId, model: model.trim(), config });
      } else {
        await postJson('/api/models', { avatarId, id, kind, providerId: resolvedProviderId, model: model.trim(), config });
      }
      toast.success(`${name || model} ✓`);
      onSaved();
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ManageDialog
      open={open}
      onOpenChange={onOpenChange}
      expandable
      title={editing ? t('model.edit', { defaultValue: 'Edit Model' }) : t('model.new')}
      description={t('model.newDesc')}
      footer={
        <ManageDialogFooterActions
          onCancel={() => onOpenChange(false)}
          onConfirm={submit}
          confirmLabel={editing ? t('common.saveChanges') : t('common.create')}
          busy={busy}
        />
      }
    >
      <ManageForm>
        <ManageField label={t('model.kind')}>
          <Select value={kind} onValueChange={(value) => setKind(value as ModelKind)}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="llm">{t('model.kindLlm')}</SelectItem>
                <SelectItem value="embedding">{t('model.kindEmbedding')}</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        </ManageField>

        <ManageField label={t('common.name')} htmlFor="model-name">
          <Input id="model-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Workspace GPT" autoFocus />
        </ManageField>

        <ManageField label={t('model.provider')}>
          <Select value={providerId} onValueChange={changeProvider}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {MODEL_PROVIDERS.map((provider) => (
                  <SelectItem key={provider.id} value={provider.id}>
                    {provider.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </ManageField>

        {providerId === 'custom' ? (
          <ManageField label={t('model.protocol', { defaultValue: 'Protocol' })}>
            <Select value={protocol} onValueChange={(value) => setProtocol(value as (typeof MODEL_PROTOCOLS)[number])}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {MODEL_PROTOCOLS.map((value) => (
                    <SelectItem key={value} value={value}>
                      {value}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </ManageField>
        ) : null}

        <ManageField label={t('model.modelName')} htmlFor="model-model">
          <Input id="model-model" value={model} onChange={(e) => setModel(e.target.value)} placeholder={kind === 'embedding' ? 'text-embedding-3-small' : 'gpt-5.1'} />
        </ManageField>

        <ManageField label={t('model.baseUrl')} htmlFor="model-base">
          <Input id="model-base" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.302.ai/v1" className="font-mono text-xs" />
        </ManageField>

        <ManageField label={t('model.apiKey')} htmlFor="model-key" description={t('model.apiKeyHint', { defaultValue: 'Required for cloud APIs; leave blank for local runtimes.' })}>
          <Input id="model-key" type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={editing ? t('model.keyKeepHint', { defaultValue: 'Leave blank to keep the saved key' }) : 'sk-...'} className="font-mono text-xs" autoComplete="off" />
        </ManageField>

        {kind === 'embedding' ? (
          <>
            <ManageField label={t('model.embeddingMode')} description={t('model.embeddingModeHint')}>
              <Select value={embeddingMode} onValueChange={(value) => setEmbeddingMode(value as 'text' | 'multimodal')}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="text">text → /embeddings</SelectItem>
                    <SelectItem value="multimodal">multimodal → /embeddings/multimodal</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            </ManageField>

            <ManageField
              label={t('model.embeddingDimension')}
              htmlFor="model-dim"
              description={t('model.embeddingDimensionHint')}
            >
              <Input id="model-dim" value={embeddingDimension} onChange={(e) => setEmbeddingDimension(e.target.value)} placeholder="2048" inputMode="numeric" className="font-mono text-xs" />
            </ManageField>
          </>
        ) : null}

        {kind === 'llm' ? (
          <>
            <ManageField label={t('model.contextWindow')} htmlFor="model-ctx" description={t('model.contextWindowCompactionHint')}>
              <Input id="model-ctx" value={contextWindow} onChange={(e) => setContextWindow(e.target.value)} placeholder="128000" inputMode="numeric" />
            </ManageField>

            <ManageField label={t('model.maxOutput')} htmlFor="model-max">
              <Input id="model-max" value={maxOutput} onChange={(e) => setMaxOutput(e.target.value)} placeholder="8192" inputMode="numeric" />
            </ManageField>

            <ManageField
              label={t('model.variants', { defaultValue: 'Reasoning-effort presets' })}
              description={t('model.variantsHint', {
                defaultValue:
                  'Named thinking-effort presets the user can switch between while chatting; leave empty to keep the model’s default behavior.',
              })}
            >
              {variantRows.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  {t('model.variantEmpty', { defaultValue: 'No presets yet — add one.' })}
                </p>
              ) : (
                <ul className="flex flex-col gap-3">
                  {variantRows.map((row, index) => (
                    <li
                      key={index}
                      className="flex flex-col gap-3 rounded-md border border-border p-3"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono text-2xs uppercase tracking-wide text-muted-foreground">
                          {row.key.trim() || `#${index + 1}`}
                        </span>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          onClick={() => removeVariantRow(index)}
                          title={t('model.removeVariant', { defaultValue: 'Remove' })}
                          aria-label={t('model.removeVariant', { defaultValue: 'Remove' })}
                        >
                          <X className="size-3.5" />
                        </Button>
                      </div>
                      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                        <label className="flex flex-col gap-1 text-2xs text-muted-foreground">
                          {t('model.variantKey', { defaultValue: 'ID (key)' })}
                          <Input
                            value={row.key}
                            onChange={(e) => updateVariantRow(index, { key: e.target.value })}
                            placeholder="low"
                            className="font-mono text-xs"
                          />
                        </label>
                        <label className="flex flex-col gap-1 text-2xs text-muted-foreground">
                          {t('model.variantLabel', { defaultValue: 'Label' })}
                          <Input
                            value={row.label}
                            onChange={(e) => updateVariantRow(index, { label: e.target.value })}
                            placeholder={t('model.variantLabelPlaceholder', { defaultValue: 'e.g. Quick · Low thinking' })}
                            className="text-xs"
                          />
                        </label>
                      </div>
                      <label className="flex flex-col gap-1 text-2xs text-muted-foreground">
                        {t('model.reasoningEffort', { defaultValue: 'Thinking effort' })}
                        <Select value={row.effort} onValueChange={(value) => updateVariantRow(index, { effort: value === DEFAULT_EFFORT_KEY ? '' : value })}>
                          <SelectTrigger className="w-full">
                            <SelectValue placeholder={t('model.effortDefault', { defaultValue: 'Default (no override)' })} />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectGroup>
                              <SelectItem value={DEFAULT_EFFORT_KEY}>
                                {t('model.effortDefault', { defaultValue: 'Default (no override)' })}
                              </SelectItem>
                              <SelectItem value="minimal">
                                {t('model.effortMinimal', { defaultValue: 'Minimal' })}
                              </SelectItem>
                              <SelectItem value="low">
                                {t('model.effortLow', { defaultValue: 'Low' })}
                              </SelectItem>
                              <SelectItem value="medium">
                                {t('model.effortMedium', { defaultValue: 'Medium' })}
                              </SelectItem>
                              <SelectItem value="high">
                                {t('model.effortHigh', { defaultValue: 'High' })}
                              </SelectItem>
                              <SelectItem value="xhigh">
                                {t('model.effortXHigh', { defaultValue: 'X-High' })}
                              </SelectItem>
                            </SelectGroup>
                          </SelectContent>
                        </Select>
                      </label>
                    </li>
                  ))}
                </ul>
              )}
              <Button variant="outline" size="sm" onClick={addVariantRow} className="mt-3 self-start">
                <Plus className="size-3.5" />
                {t('model.addVariant', { defaultValue: 'Add a preset' })}
              </Button>
            </ManageField>
          </>
        ) : null}

        <ManagePreviewBlock className="text-xs text-muted-foreground">{t('model.secretHint')}</ManagePreviewBlock>
      </ManageForm>
    </ManageDialog>
  );
}

function numeric(value: string): number | undefined {
  const n = Number(value.trim());
  return value.trim() && Number.isFinite(n) ? n : undefined;
}

function compact(obj: Record<string, unknown>): Record<string, unknown> | undefined {
  const entries = Object.entries(obj).filter(([, v]) => v !== undefined && v !== null && v !== '');
  return entries.length ? Object.fromEntries(entries) : undefined;
}

/** Parse a stored `config.variants` blob into editable rows. */
function readVariantRows(raw: unknown): VariantRow[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  const rows: VariantRow[] = [];
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const entry = (value ?? {}) as { displayName?: unknown; reasoningEffort?: unknown };
    rows.push({
      key,
      label: typeof entry.displayName === 'string' ? entry.displayName : '',
      effort: typeof entry.reasoningEffort === 'string' ? entry.reasoningEffort : '',
    });
  }
  return rows;
}

/** Turn the editable rows into the `config.variants` shape (dropping empty keys). */
function buildVariantsConfig(rows: VariantRow[]): Record<string, { displayName?: string; reasoningEffort?: string }> {
  const out: Record<string, { displayName?: string; reasoningEffort?: string }> = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (!key) continue;
    const entry: { displayName?: string; reasoningEffort?: string } = {};
    if (row.label.trim()) entry.displayName = row.label.trim();
    if (row.effort) entry.reasoningEffort = row.effort;
    out[key] = entry;
  }
  return out;
}
