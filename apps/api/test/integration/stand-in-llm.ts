/**
 * A stand-in for an outside AI provider (OpenAI-style API) on localhost. It lists two models,
 * answers chat requests with a fixed streamed reply, refuses the key "bad-key-0000", and keeps
 * every request it received, so tests can prove what was (and wasn't) sent outside.
 */
import { createServer, type Server } from 'node:http';

export interface ReceivedRequest {
  path: string;
  authorization: string | undefined;
  body: unknown;
}

export class StandInLlm {
  readonly received: ReceivedRequest[] = [];
  /** The streamed answer; tests may change it. */
  reply = 'From the stand-in [1].';
  private server: Server | null = null;
  url = '';

  async start(): Promise<this> {
    this.server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c: Buffer) => (raw += c.toString()));
      req.on('end', () => {
        const path = req.url ?? '';
        this.received.push({
          path,
          authorization: req.headers.authorization,
          body: raw ? (JSON.parse(raw) as unknown) : null,
        });
        if (req.headers.authorization === 'Bearer bad-key-0000') {
          res.writeHead(401).end('{}');
          return;
        }
        if (path.endsWith('/models')) {
          res.setHeader('content-type', 'application/json');
          res.end(
            JSON.stringify({
              data: [{ id: 'stand-in-large' }, { id: 'stand-in-small' }, { id: 'embed-x' }],
            }),
          );
          return;
        }
        if (path.endsWith('/chat/completions')) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          for (const word of this.reply.split(/(?<= )/)) {
            res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: word } }] })}\n\n`);
          }
          res.write(
            `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 321, completion_tokens: 12 } })}\n\n`,
          );
          res.end('data: [DONE]\n\n');
          return;
        }
        res.writeHead(404).end();
      });
    });
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', r));
    const address = this.server.address();
    this.url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/v1`;
    return this;
  }

  /** Every prompt text sent to the chat endpoint, joined. */
  sentText(): string {
    return this.received
      .filter((r) => r.path.endsWith('/chat/completions'))
      .map((r) => JSON.stringify(r.body))
      .join('\n');
  }

  async stop(): Promise<void> {
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
  }
}
