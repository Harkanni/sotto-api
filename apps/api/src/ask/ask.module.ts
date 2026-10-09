import { Module } from '@nestjs/common';
import { AiService } from './ai.service.js';
import { RetrievalService } from './retrieval.service.js';

/** Ask and search (Phase 5): retrieval, answers, chats and notes. */
@Module({
  providers: [AiService, RetrievalService],
  exports: [AiService, RetrievalService],
})
export class AskModule {}
