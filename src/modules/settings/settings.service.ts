import { BadRequestException, Injectable } from '@nestjs/common';
import { Repository } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';
import { AssistantSetting, ASSISTANT_SETTINGS_SINGLETON_ID } from '../../database/entities/assistant-setting.entity';
import { DEFAULT_SYSTEM_PROMPT } from '../../database/seeds/default-system-prompt';
import { getEnv } from '../../config/env';

export interface UpdateAssistantSettingsInput {
  system_prompt?: string;
  model?: string;
  is_active?: boolean;
}

export interface AssistantModel {
  id: string;
  label: string;
}

export interface ModelListResult {
  models: AssistantModel[];
  source: 'openrouter' | 'fallback';
  fetchedAt?: string;
}

/** Shown while the OpenRouter key is absent (no network call in that state). */
export const FALLBACK_MODELS: AssistantModel[] = [
  { id: 'nvidia/nemotron-3-ultra-550b-a55b:free', label: 'nvidia/nemotron-3-ultra-550b-a55b:free (default)' },
  { id: 'openrouter/auto', label: 'openrouter/auto (paid routing)' },
  { id: 'openai/gpt-4o-mini', label: 'openai/gpt-4o-mini' },
  { id: 'anthropic/claude-3.5-sonnet', label: 'anthropic/claude-3.5-sonnet' },
  { id: 'meta-llama/llama-3.3-70b-instruct', label: 'meta-llama/llama-3.3-70b-instruct' },
];

const MODELS_CACHE_TTL_MS = 60 * 60 * 1000;

/**
 * Assistant settings — one row (id = 1). get() is read on EVERY AI request
 * (no cache) so panel changes apply instantly.
 */
@Injectable()
export class SettingsService {
  private modelsCache: { at: number; models: AssistantModel[] } | null = null;

  constructor(
    @InjectRepository(AssistantSetting) private readonly repo: Repository<AssistantSetting>,
  ) {}

  async get(): Promise<AssistantSetting> {
    const row = await this.repo.findOneBy({ id: ASSISTANT_SETTINGS_SINGLETON_ID });
    if (row) return row;
    // self-heal if the row is missing (normally seeded at boot)
    return this.repo.save(
      this.repo.create({
        id: ASSISTANT_SETTINGS_SINGLETON_ID,
        system_prompt: DEFAULT_SYSTEM_PROMPT,
        model: getEnv().OPENROUTER_DEFAULT_MODEL,
        is_active: true,
      }),
    );
  }

  async update(patch: UpdateAssistantSettingsInput, adminId: string | null): Promise<AssistantSetting> {
    const current = await this.get();

    if (patch.system_prompt !== undefined) {
      const t = patch.system_prompt.trim();
      if (!t) throw new BadRequestException('system_prompt must not be empty');
      if (t.length > 8000) throw new BadRequestException('system_prompt too long (max 8000 characters)');
      current.system_prompt = t;
    }
    if (patch.model !== undefined) {
      const m = patch.model.trim();
      if (!m || m.length > 128) throw new BadRequestException('model must be 1..128 characters');
      current.model = m;
    }
    if (patch.is_active !== undefined) current.is_active = patch.is_active;

    current.updated_by_admin_id = adminId;
    return this.repo.save(current);
  }

  /**
   * Model list for the panel dropdown, 1 h cache. While the OpenRouter key is
   * empty (current state, per the owner's instruction) this NEVER touches the
   * network and returns a curated fallback list — the panel must never break.
   */
  async listModels(): Promise<ModelListResult> {
    const env = getEnv();
    if (!env.OPENROUTER_API_KEY) {
      return { models: FALLBACK_MODELS, source: 'fallback' };
    }
    if (this.modelsCache && Date.now() - this.modelsCache.at < MODELS_CACHE_TTL_MS) {
      return { models: this.modelsCache.models, source: 'openrouter', fetchedAt: new Date(this.modelsCache.at).toISOString() };
    }
    try {
      const res = await fetch('https://openrouter.ai/api/v1/models', {
        headers: { authorization: `Bearer ${env.OPENROUTER_API_KEY}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = JSON.parse(await res.text()) as { data?: { id: string; name?: string }[] };
      const models = (data.data ?? []).map((m) => ({ id: m.id, label: m.name ?? m.id }));
      this.modelsCache = { at: Date.now(), models };
      return { models, source: 'openrouter', fetchedAt: new Date().toISOString() };
    } catch {
      return { models: FALLBACK_MODELS, source: 'fallback' };
    }
  }
}
