import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AssistantSetting } from '../../database/entities/assistant-setting.entity';
import { SettingsService } from './settings.service';

@Module({
  imports: [TypeOrmModule.forFeature([AssistantSetting])],
  providers: [SettingsService],
  exports: [SettingsService],
})
export class SettingsModule {}
