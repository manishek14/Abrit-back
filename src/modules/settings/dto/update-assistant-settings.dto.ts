import { IsBoolean, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class UpdateAssistantSettingsDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(8000)
  system_prompt?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  model?: string;

  @IsOptional()
  @IsBoolean()
  is_active?: boolean;
}
