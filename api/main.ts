import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { RedisCacheInterceptor } from './common/interceptors/redis-cache.interceptor';
import { Reflector } from '@nestjs/core';
import { startWS } from './ws';
import { apiKeyGuard } from './common/middleware/api-key.middleware';
import { requestLogger } from './common/middleware/request-logger.middleware';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.set('trust proxy', true);
  app.use(requestLogger);
  app.use(apiKeyGuard);
  app.enableCors();
  app.useGlobalInterceptors(new RedisCacheInterceptor(app.get(Reflector)));
  startWS(app.getHttpServer(), { path: '/ws' });
  const port = Number(process.env.API_PORT || process.env.PORT || 8004);
  await app.listen(port);
}
bootstrap();
