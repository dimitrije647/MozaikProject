import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';

async function bootstrap() {
  const app = configureApp(await NestFactory.create(AppModule));
  // SIGTERM/SIGINT run module destroy hooks: active Mozaik runs are stopped and recorded as interrupted.
  app.enableShutdownHooks();
  const port = Number(process.env.API_PORT ?? 4000);
  await app.listen(port);
  console.log(`LaunchPilot API listening on http://localhost:${port}`);
}
bootstrap();
