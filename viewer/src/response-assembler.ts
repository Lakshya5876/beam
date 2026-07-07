import { FrameType, type Frame } from './protocol-bridge.js';

export type AssemblerFeedResult = 'continue' | 'complete' | 'error';

interface ResponseHeadPayload {
  status: number;
  headers: Record<string, string>;
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
    const { status, headers } = this.headPayload;
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.controller = controller;
      },
    });
    // Null-body statuses reject a stream body in the Response constructor.
    if (status === 204 || status === 205 || status === 304) {
      return new Response(null, { status, headers });
    }
    return new Response(stream, { status, headers });
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

/**
 * Host contract (relay-use-case encodeResponseHead): {status, headers} with
 * headers as a string Record. The previous shape here ({status, statusText,
 * headers: [string,string][]}) never matched what the host sends — every
 * response head was rejected. Caught by the local e2e harness.
 */
function isStringRecord(value: unknown): value is Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return Object.values(value).every((v) => typeof v === 'string');
}

function parseHead(payload: Uint8Array): ResponseHeadPayload | null {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(payload)) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const obj = parsed as { status?: unknown; headers?: unknown };
    if (typeof obj.status !== 'number' || !Number.isInteger(obj.status)) return null;
    if (!isStringRecord(obj.headers)) return null;
    return { status: obj.status, headers: obj.headers };
  } catch {
    return null;
  }
}
