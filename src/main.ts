import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { getEnv } from './config/env';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  const env = getEnv();

  app.setGlobalPrefix('api');
  app.use(helmet());
  app.enableCors({
    origin: env.CORS_ORIGIN.split(',').map((o) => o.trim()),
    credentials: false,
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // Interactive API docs (Bearer-auth protected routes marked accordingly)
  const swaggerConfig = new DocumentBuilder()
    .setTitle('AbrIT Ticketing API')
    .setDescription('AI-powered Telegram ticketing system — admin REST API')
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api/docs', app, document);

  await app.listen(env.PORT);
  Logger.log(`AbrIT API listening on http://localhost:${env.PORT}/api (docs: /api/docs)`, 'Bootstrap');
}

void bootstrap();
