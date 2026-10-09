import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  type ChatProvider,
  type DataLocation,
  type EmbeddingProvider,
  type Sensitivity,
  askChatFrom,
  embeddingProviderFrom,
} from '@sotto/ai';
import type { AiRoute } from '@sotto/db';
import { APP_CONFIG, type ApiConfig } from '../config.js';
import { PrismaService } from '../core.module.js';

/** How long the serving embedding model is trusted before it's looked up again. */
const SERVING_TTL_MS = 30_000;

export interface ServingIndex {
  model: string;
  dims: number;
}

/** The chat that answers in Ask, and what the data-route badge says about it. */
export interface AskChat {
  provider: ChatProvider;
  model: string;
  route: AiRoute;
  routeLabel: string;
  dataLocation: DataLocation;
  isMock: boolean;
}

/**
 * The AI the api calls itself: the embedding model for searching (the same one the worker
 * indexes with), and the chat model that answers in Ask. Both come from the platform settings
 * (packages/ai); Phase 6 adds workspace choices on top.
 */
@Injectable()
export class AiService {
  private readonly log = new Logger('ai');
  readonly embeddings: EmbeddingProvider;
  readonly chat: AskChat | null;
  private serving: { at: number; value: ServingIndex | null } | null = null;

  constructor(
    @Inject(APP_CONFIG) config: ApiConfig,
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {
    this.embeddings = embeddingProviderFrom(config);
    const chat = askChatFrom(config);
    this.chat = chat
      ? {
          ...chat,
          dataLocation: chat.provider.dataLocation,
          route: routeOf(chat.provider.dataLocation),
          routeLabel: routeLabelOf(chat.provider),
          isMock: chat.provider.isMock === true,
        }
      : null;
  }

  /** The embedding model searches use (the first one indexed, until a re-index swaps it). */
  async servingIndex(): Promise<ServingIndex | null> {
    if (this.serving && Date.now() - this.serving.at < SERVING_TTL_MS) return this.serving.value;
    const row = await this.prisma.client.embeddingIndex.findFirst({
      where: { serving: true, status: 'READY' },
      select: { model: true, dims: true },
    });
    this.serving = { at: Date.now(), value: row };
    return row;
  }

  /** Forgets the cached serving model (tests, and later the re-index job). */
  resetServing(): void {
    this.serving = null;
  }

  /**
   * The question as a vector in the serving model's space, or null when semantic search can't
   * run: nothing indexed yet, the api configured with a different model than the index, or the
   * embedding server down. Search then runs on keywords alone and says so.
   */
  async queryVector(
    question: string,
    signal?: AbortSignal,
  ): Promise<{ model: string; dims: number; vector: number[] } | null> {
    const serving = await this.servingIndex();
    if (!serving) return null;
    const model = `${this.embeddings.id}:${this.embeddings.model}`;
    if (serving.model !== model) {
      this.log.warn(`searching by keyword only: index is ${serving.model}, api embeds ${model}`);
      return null;
    }
    try {
      const [vector] = await this.embeddings.embed([question], { purpose: 'query', signal });
      if (!vector || vector.length !== serving.dims) return null;
      return { model, dims: serving.dims, vector };
    } catch (error) {
      if (signal?.aborted) throw error;
      this.log.warn(`query embedding failed (${error instanceof Error ? error.name : 'error'})`);
      return null;
    }
  }

  /**
   * Sensitivities the answering model may read (BRIEF §3): everything for an in-cluster model;
   * for a third party, Internal only until Phase 6 makes Confidential a workspace setting.
   * Search results aren't sent to any model, so search uses every sensitivity.
   */
  allowedFor(chat: AskChat | null): Sensitivity[] {
    if (!chat || chat.dataLocation === 'IN_CLUSTER')
      return ['INTERNAL', 'CONFIDENTIAL', 'RESTRICTED'];
    return ['INTERNAL'];
  }
}

export function routeOf(location: DataLocation): AiRoute {
  // Phase 5's only outside model is the platform's own account; BYOK arrives in Phase 6.
  return location === 'IN_CLUSTER' ? 'PRIVATE' : 'MANAGED';
}

/** "Private · Ollama (in your cluster)", "Managed · Hosted model"; mocks say so. */
export function routeLabelOf(provider: ChatProvider): string {
  if (provider.isMock) return 'Mock chat · no model';
  const where = provider.dataLocation === 'IN_CLUSTER' ? 'Private' : 'Managed';
  return `${where} · ${provider.label}`;
}
