import { Module } from '@nestjs/common';
import { TokensController } from './tokens.controller';
import { TokensService } from './tokens.service';
import { PgModule } from '../db/pg.module';
import { TokenSummaryPublisher } from './token-summary.publisher';

@Module({
  imports: [PgModule],
  controllers: [TokensController],
  providers: [TokensService, TokenSummaryPublisher],
})
export class TokensModule {}
