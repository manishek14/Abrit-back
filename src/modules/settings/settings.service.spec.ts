import { BadRequestException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { SettingsService } from './settings.service';
import { AssistantSetting } from '../../database/entities/assistant-setting.entity';
import { setTestEnv } from '../../common/testing/test-env';

setTestEnv();

const mkRow = (over: Partial<AssistantSetting> = {}): AssistantSetting =>
  ({
    id: 1,
    system_prompt: 'پرامپت',
    model: 'openrouter/auto',
    is_active: true,
    updated_by_admin_id: null,
    updated_at: new Date(),
    ...over,
  }) as AssistantSetting;

describe('SettingsService', () => {
  let repo: { findOneBy: jest.Mock; save: jest.Mock; create: (x: Record<string, unknown>) => Record<string, unknown> };
  let service: SettingsService;

  beforeEach(() => {
    setTestEnv();
    repo = {
      findOneBy: jest.fn(),
      save: jest.fn(async (x: Record<string, unknown>) => x),
      create: (x) => x,
    };
    service = new SettingsService(repo as unknown as Repository<AssistantSetting>);
  });

  it('returns the singleton row when it exists', async () => {
    const row = mkRow();
    repo.findOneBy.mockResolvedValueOnce(row);
    expect(await service.get()).toBe(row);
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('self-heals the missing singleton row with defaults from env', async () => {
    repo.findOneBy.mockResolvedValueOnce(null);
    const row = await service.get();
    expect(repo.save).toHaveBeenCalledTimes(1);
    expect(row.model).toBe('openrouter/auto');
    expect(row.is_active).toBe(true);
  });

  it('applies validated patches and stamps the admin', async () => {
    const row = mkRow();
    repo.findOneBy.mockResolvedValue(row);

    const updated = await service.update(
      { system_prompt: 'پرامپت جدید', model: 'openai/gpt-4o-mini', is_active: false },
      'admin-uuid-1',
    );

    expect(updated.system_prompt).toBe('پرامپت جدید');
    expect(updated.model).toBe('openai/gpt-4o-mini');
    expect(updated.is_active).toBe(false);
    expect(updated.updated_by_admin_id).toBe('admin-uuid-1');
  });

  it('rejects invalid patches', async () => {
    repo.findOneBy.mockResolvedValue(mkRow());
    await expect(service.update({ model: '' }, null)).rejects.toThrow(BadRequestException);
    await expect(service.update({ system_prompt: '   ' }, null)).rejects.toThrow(BadRequestException);
  });

  it('listModels returns the curated fallback list without network while the key is empty', async () => {
    setTestEnv({ OPENROUTER_API_KEY: '' });
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    const res = await service.listModels();
    expect(res.source).toBe('fallback');
    expect(res.models.length).toBeGreaterThan(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
