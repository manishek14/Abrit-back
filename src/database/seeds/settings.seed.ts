import { DataSource } from 'typeorm';
import { AssistantSetting, ASSISTANT_SETTINGS_SINGLETON_ID } from '../entities/assistant-setting.entity';
import { DEFAULT_SYSTEM_PROMPT } from './default-system-prompt';

/**
 * Ensures the singleton assistant settings row (id = 1) exists with the default
 * prompt and the default model from env. Never overwrites later admin changes.
 */
export async function seedAssistantSettings(ds: DataSource, defaultModel: string): Promise<void> {
  const repo = ds.getRepository(AssistantSetting);
  const existing = await repo.findOneBy({ id: ASSISTANT_SETTINGS_SINGLETON_ID });
  if (existing) return;

  await repo.insert({
    id: ASSISTANT_SETTINGS_SINGLETON_ID,
    system_prompt: DEFAULT_SYSTEM_PROMPT,
    model: defaultModel,
    is_active: true,
  });
}
