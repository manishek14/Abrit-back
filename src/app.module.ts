import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { parseEnv } from './config/env';
import { buildTypeOrmOptions } from './config/typeorm.config';
import { HealthModule } from './modules/health/health.module';

@Module({
  imports: [
    // Fail fast: the process refuses to boot with an invalid/missing env config.
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env', '../.env'],
      validate: (raw) =>
        parseEnv(raw as Record<string, string | undefined>) as unknown as Record<string, unknown>,
    }),
    TypeOrmModule.forRootAsync({
      useFactory: () => buildTypeOrmOptions(),
    }),
    HealthModule,
  ],
})
export class AppModule {}
