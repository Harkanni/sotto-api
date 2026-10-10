import { Inject, Injectable, Logger } from '@nestjs/common';
import { type EmbeddingProvider, embeddingProviderFrom } from '@sotto/ai';
import { APP_CONFIG, type ApiConfig } from '../config.js';
import { PrismaService } from '../core.module.js';

/** How long the serving embedding model is trusted before it's looked up again. */
const SERVING_TTL_MS = 30_000;

export interface ServingIndex {
  model: string;
  dims: number;
}

/**
 * The embedding model the api searches with (the same one the worker indexes with), from the
 * platform settings. Which chat answers is the workspace's choice: `AiSettingsService` (Phase 6).
 */
@Injectable()
export class AiService {
  private readonly log = new Logger('ai');
  readonly embeddings: EmbeddingProvider;
  private serving: { at: number; value: ServingIndex | null } | null = null;

  constructor(
    @Inject(APP_CONFIG) config: ApiConfig,
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {
    this.embeddings = embeddingProviderFrom(config);
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
}
