import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  ServiceUnavailableException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { InjectDataSource } from '@nestjs/typeorm';

@Controller('health')
export class HealthController {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /** Public liveness probe — also verifies the DB connection. */
  @Get()
  @HttpCode(HttpStatus.OK)
  async check(): Promise<{ status: string; db: string; time: string }> {
    try {
      await this.dataSource.query('SELECT 1');
      return { status: 'ok', db: 'up', time: new Date().toISOString() };
    } catch {
      throw new ServiceUnavailableException({ status: 'error', db: 'down' });
    }
  }
}
