import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { getEnv } from '../config/env';
import { seedAdmin } from './seeds/admin.seed';
import { seedAssistantSettings } from './seeds/settings.seed';
import { seedDemoData } from './seeds/demo-data.seed';

/**
 * Idempotent bootstrap seeding, runs after migrations on every boot:
 *  - first admin (from ADMIN_EMAIL / ADMIN_PASSWORD, bcrypt-hashed),
 *  - singleton assistant settings row (id = 1),
 *  - Persian demo data when the database is empty and SEED_DEMO_DATA=true.
 */
@Injectable()
export class DatabaseInitService implements OnModuleInit {
  private readonly logger = new Logger('DatabaseInit');

  constructor(@InjectDataSource() private readonly ds: DataSource) {}

  async onModuleInit(): Promise<void> {
    const env = getEnv();

    await seedAdmin(this.ds, env.ADMIN_EMAIL, env.ADMIN_PASSWORD);
    await seedAssistantSettings(this.ds, env.OPENROUTER_DEFAULT_MODEL);

    if (env.SEED_DEMO_DATA) {
      await seedDemoData(this.ds);
    }

    this.logger.log('Bootstrap seed check complete (admin, assistant settings, demo data)');
  }
}
