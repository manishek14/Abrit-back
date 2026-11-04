import { Body, Controller, Get, Param, Patch } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { SettingsService } from './settings.service';
import { UpdateAssistantSettingsDto } from './dto/update-assistant-settings.dto';
import { CurrentAdmin } from '../../common/decorators/current-admin.decorator';

@Controller('settings')
@ApiTags('settings')
@ApiBearerAuth()
export class SettingsController {
  constructor(private readonly settingsService: SettingsService) {}

  @Get('assistant')
  async get() {
    return { data: await this.settingsService.get() };
  }

  @Patch('assistant')
  async update(
    @Body() dto: UpdateAssistantSettingsDto,
    @CurrentAdmin() admin: { sub?: string } | undefined,
  ) {
    return { data: await this.settingsService.update(dto, admin?.sub ?? null) };
  }

  @Get('assistant/models')
  async models() {
    return { data: await this.settingsService.listModels() };
  }
}
