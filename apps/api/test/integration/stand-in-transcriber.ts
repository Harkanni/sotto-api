/**
 * A stand-in for the transcriber's HTTP API on localhost: `GET /v1/engines` and
 * `POST /v1/transcribe`. Each chunk is "heard" as one line ("Line 1", "Line 2", …) spanning most
 * of the chunk, so tests can check order and timing. It keeps every request's size, can fail
 * the next calls, and can claim its engine sends audio outside the cluster.
 */
import { createServer, type Server } from 'node:http';

export class StandInTranscriber {
  readonly received: { path: string; bytes: number; inClusterOnly: boolean }[] = [];
  dataLocation: 'IN_CLUSTER' | 'THIRD_PARTY' = 'IN_CLUSTER';
  /** Transcribe calls left to fail with 500 (0: none). */
  failNext = 0;
  /** Delay before answering, to keep chunks in flight. */
  delayMs = 0;
  private lines = 0;
  private server: Server | null = null;
  url = '';

  /** How many transcribe calls arrived. */
  get transcribed(): number {
    return this.received.filter((r) => r.path === '/v1/transcribe').length;
  }

  async start(): Promise<this> {
    this.server = createServer((req, res) => {
      let bytes = 0;
      let raw = '';
      req.on('data', (c: Buffer) => {
        bytes += c.length;
        raw += c.toString('latin1');
      });
      req.on('end', () => {
        const path = req.url ?? '';
        // The form field the api adds for Restricted audio (a multipart part named in_cluster_only).
        const inClusterOnly = /name="in_cluster_only"\r\n\r\ntrue/.test(raw);
        this.received.push({ path, bytes, inClusterOnly });
        res.setHeader('content-type', 'application/json');
        if (path === '/v1/engines') {
          res.end(
            JSON.stringify({
              active: 'stand-in',
              model: 'stand-in-1',
              available: ['stand-in'],
              dataLocation: this.dataLocation,
              isMock: false,
            }),
          );
          return;
        }
        if (path === '/v1/transcribe') {
          if (inClusterOnly && this.dataLocation !== 'IN_CLUSTER') {
            res.writeHead(409).end('{"detail":"engine sends audio outside the cluster"}');
            return;
          }
          const answer = () => {
            if (this.failNext > 0) {
              this.failNext -= 1;
              res.writeHead(500).end('{}');
              return;
            }
            this.lines += 1;
            res.end(
              JSON.stringify({
                engine: 'stand-in',
                model: 'stand-in-1',
                language: 'en',
                durationMs: 4_000,
                isMock: false,
                segments: [{ startMs: 200, endMs: 3_800, text: ` Line ${this.lines} ` }],
              }),
            );
          };
          if (this.delayMs) setTimeout(answer, this.delayMs);
          else answer();
          return;
        }
        res.writeHead(404).end('{}');
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    this.url = `http://127.0.0.1:${address.port}`;
    return this;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()) ?? resolve());
  }
}
