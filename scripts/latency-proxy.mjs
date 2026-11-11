/**
 * Latency-injecting TCP proxy for database performance testing.
 *
 * Forwards :PORT -> :5433 (local Postgres) adding DELAY_MS to every
 * client->server data chunk. With DELAY_MS=200 this approximates a ~400ms
 * round-trip remote database (documented as a simulation - the real remote
 * leg was measured directly at ~390-520ms/query, 4-5s connect).
 *
 * Usage: node scripts/latency-proxy.mjs [--port 5434] [--delay 200]
 */

import net from 'node:net';

function argVal(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : fallback;
}

const PORT = argVal('--port', 5434);
const DELAY = argVal('--delay', 200);
const TARGET_PORT = argVal('--target', 5433);

const server = net.createServer((client) => {
  const upstream = net.connect(TARGET_PORT, '127.0.0.1');
  client.on('data', (chunk) => {
    setTimeout(() => upstream.write(chunk), DELAY);
  });
  upstream.on('data', (chunk) => {
    // Server->client: no extra delay (one-way leg already counted above).
    client.write(chunk);
  });
  const teardown = () => {
    client.destroy();
    upstream.destroy();
  };
  client.on('error', teardown);
  upstream.on('error', teardown);
  client.on('close', () => upstream.destroy());
  upstream.on('close', () => client.destroy());
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(JSON.stringify({ proxy: 'up', port: PORT, target: TARGET_PORT, delayMs: DELAY }));
});
