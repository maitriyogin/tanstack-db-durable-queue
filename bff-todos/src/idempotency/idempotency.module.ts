import { Module } from '@nestjs/common';
import { IdempotencyService } from './idempotency.service';
import { PrismaService } from '../prisma/prisma.service';

@Module({
  providers: [PrismaService, IdempotencyService],
  exports: [IdempotencyService],
})
export class IdempotencyModule {}