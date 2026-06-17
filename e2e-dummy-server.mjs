/* eslint-disable no-undef */
/**
 * Dummy HTTP server for S18 E2E testing.
 * Serves a 25,000-byte plain text response on any request to /.
 * Used to verify RTCDataChannel ceiling (Proof 0) and backpressure (Proof 4).
 *
 * Run: node e2e-dummy-server.mjs
 */

import http from 'node:http';

const PORT = 3000;

// 25,000 bytes of 'A' — large enough to hit the RTCDataChannel ceiling
// if MAX_PAYLOAD_SIZE is not reduced below 16,384 bytes.
const PAYLOAD = 'A'.repeat(25_000);

const server = http.createServer((req, res) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.url}`);
  res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': PAYLOAD.length });
  res.end(PAYLOAD);
});

server.listen(PORT, () => {
  console.log(`Server listening on ${PORT}`);
});
