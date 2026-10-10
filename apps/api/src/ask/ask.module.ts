import { Module } from '@nestjs/common';
import { CollectionsModule } from '../collections/collections.controller.js';
import { FilesModule } from '../files/files.controller.js';
import { AiService } from './ai.service.js';
import { AskService } from './ask.service.js';
import { ConversationsController } from './conversations.controller.js';
import { NotesController } from './notes.controller.js';
import { RetrievalService } from './retrieval.service.js';
import { SearchController } from './search.controller.js';

/** Ask and search (Phase 5): retrieval, search, answers, chats and notes. */
@Module({
  imports: [CollectionsModule, FilesModule],
  controllers: [SearchController, NotesController, ConversationsController],
  providers: [AiService, RetrievalService, AskService],
  exports: [AiService, RetrievalService, AskService],
})
export class AskModule {}
