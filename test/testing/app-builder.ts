import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module';
import { TELEGRAM_GATEWAY } from '../../src/modules/telegram/telegram-gateway.interface';
import { FakeTelegramGateway } from '../fakes/telegram-gateway.fake';

export interface TestApp {
  app: INestApplication;
  fakeGateway: FakeTelegramGateway;
}

/**
 * Boots the full application (migrations, seeds, webhook, guards, WS gateway)
 * with ONLY the Telegram transport replaced by a fake — every other component
 * is real, including PostgreSQL. app.listen(0) keeps behavior identical to
 * production boot and lets supertest use the real HTTP server.
 */
export async function createTestApp(): Promise<TestApp> {
  const fakeGateway = new FakeTelegramGateway();

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  })
    .overrideProvider(TELEGRAM_GATEWAY)
    .useValue(fakeGateway)
    .compile();

  const app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api');
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  await app.listen(0);

  return { app, fakeGateway };
}
