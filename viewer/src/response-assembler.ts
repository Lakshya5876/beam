import { FrameType, type Frame } from './protocol-bridge.js';

export type AssemblerFeedResult = 'continue' | 'complete' | 'error';

interface ResponseHeadPayload {
  status: number;
  statusText: string;
  headers: [string, string][];
}

type AssemblerState = 'idle' | 'head_received' | 'streaming' | 'complete' | 'errored';

export class ResponseAssembler {
  private state: AssemblerState = 'idle';
  private controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  private headPayload: ResponseHeadPayload | null = null;

  feed(frame: Frame): AssemblerFeedResult {
    if (frame.type === FrameType.RESPONSE_HEAD) return this.feedHead(frame);
    if (frame.type === FrameType.RESPONSE_BODY_CHUNK) return this.feedBody(frame);
    if (frame.type === FrameType.RESPONSE_END) return this.feedEnd();
    return 'continue';
  }

  private feedHead(frame: Frame): AssemblerFeedResult {
    if (this.state !== 'idle') return 'error';
    const parsed = parseHead(frame.payload);
    if (!parsed) return 'error';
    this.headPayload = parsed;
    this.state = 'head_received';
    return 'continue';
  }

  private feedBody(frame: Frame): AssemblerFeedResult {
    if (this.state !== 'head_received' && this.state !== 'streaming') return 'error';
    this.state = 'streaming';
    this.controller?.enqueue(new Uint8Array(frame.payload));
    return 'continue';
  }

  private feedEnd(): AssemblerFeedResult {
    if (this.state !== 'head_received' && this.state !== 'streaming') return 'error';
    this.controller?.close();
    this.state = 'complete';
    return 'complete';
  }

  /**
   * Build the browser Response. Must be called after RESPONSE_HEAD feed.
   * Returns a streaming Response — body may not be complete yet.
   */
  buildResponse(): Response {
    if (!this.headPayload) throw new Error('buildResponse called before RESPONSE_HEAD');
    const { status, statusText, headers } = this.headPayload;
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.controller = controller;
      },
    });
    return new Response(stream, { status, statusText, headers });
  }

  /**
   * N3 / B2: abort any open stream on mid-stream disconnect.
   * Called by the SW on relay-error. Noop if idle or already complete/errored.
   */
  abort(reason: string): void {
    if (this.state === 'idle' || this.state === 'complete' || this.state === 'errored') return;
    this.state = 'errored';
    this.controller?.error(new Error(reason));
  }
}

function parseHead(payload: Uint8Array): ResponseHeadPayload | null {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(payload)) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return null;
    const obj = parsed as { status?: unknown; statusText?: unknown; headers?: unknown };
    if (typeof obj.status !== 'number') return null;
    if (typeof obj.statusText !== 'string') return null;
    if (!Array.isArray(obj.headers)) return null;
    return { status: obj.status, statusText: obj.statusText, headers: obj.headers as [string, string][] };
  } catch {
    return null;
  }
}
