import {
  decodeFrame,
  encodeFrame,
  isFrameDecodeError,
  type Frame,
} from './protocol-bridge.js';
import {
  ok,
  err,
  type PeerTransport,
  type Result,
  type TransportClosedError,
  type Unsubscribe,
} from '../../src/domain/interfaces.js';

export class BrowserDataChannelAdapter implements PeerTransport {
  constructor(private dc: RTCDataChannel) {}

  send(frame: Frame): Result<undefined, TransportClosedError> {
    if (this.dc.readyState === 'closed' || this.dc.readyState === 'closing') {
      return err({ error: 'TransportClosed' });
    }
    this.dc.send(encodeFrame(frame));
    return ok();
  }

  onFrame(handler: (frame: Frame) => void): Unsubscribe {
    const listener = (event: MessageEvent): void => {
      // C1: ArrayBuffer from dc.onmessage must be wrapped — never cast
      const bytes = new Uint8Array(event.data as ArrayBuffer);
      const decoded = decodeFrame(bytes);
      if (!isFrameDecodeError(decoded)) {
        handler(decoded);
      }
      // Decode errors silently dropped — malformed peer data is expected
    };
    this.dc.addEventListener('message', listener);
    return () => this.dc.removeEventListener('message', listener);
  }

  onClose(handler: (reason: string) => void): Unsubscribe {
    const listener = (): void => handler('data-channel-closed');
    this.dc.addEventListener('close', listener);
    return () => this.dc.removeEventListener('close', listener);
  }

  close(): void {
    this.dc.close();
  }

  bufferedAmount(): number {
    return this.dc.bufferedAmount;
  }
}
