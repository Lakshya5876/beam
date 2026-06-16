/**
 * Impure boundary: wraps real browser WebSocket into the SignalingSocket port.
 * NOT unit-tested here (live at S18); excluded from coverage gate.
 */

import type { SignalingSocket } from './viewer-connection.js';

export class BrowserWebSocketAdapter implements SignalingSocket {
  constructor(private ws: WebSocket) {}

  async send(text: string): Promise<void> {
    return new Promise((resolve) => {
      this.ws.send(text);
      // WebSocket.send is synchronous; await the promise for compatibility
      setImmediate(resolve);
    });
  }

  onmessage(handler: (text: string) => void): void {
    this.ws.onmessage = (event) => {
      if (typeof event.data === 'string') {
        handler(event.data);
      }
    };
  }

  onclose(handler: () => void): void {
    this.ws.onclose = () => {
      handler();
    };
  }

  close(): void {
    this.ws.close();
  }
}
