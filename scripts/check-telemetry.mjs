// Sanity check for the packet layout: listens for real or synthetic F1 25
// traffic, decodes it, and prints the brief the engineer would receive.
//
//   node scripts/replay-udp.mjs        (terminal 1)
//   node scripts/check-telemetry.mjs   (terminal 2)

import dgram from 'node:dgram';
import esbuild from 'esbuild';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const port = Number(process.env.UDP_PORT ?? 20777);
const seconds = Number(process.argv[2] ?? 3);

const bundlePath = path.join(os.tmpdir(), `f1-check-${Date.now()}.mjs`);
await esbuild.build({
  entryPoints: [path.join(root, 'src/telemetry/index-check.ts')],
  outfile: bundlePath,
  bundle: true,
  platform: 'node',
  format: 'esm',
  logLevel: 'silent',
});

const { parsePacket, SnapshotBuilder, buildEngineerBrief } = await import(
  pathToFileURL(bundlePath).href
);

const builder = new SnapshotBuilder();
const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
const seen = new Map();

socket.on('message', (msg) => {
  builder.markPacketSeen();
  const parsed = parsePacket(msg);
  if (parsed) {
    seen.set(parsed.id, (seen.get(parsed.id) ?? 0) + 1);
    builder.apply(parsed);
  } else {
    seen.set('unparsed', (seen.get('unparsed') ?? 0) + 1);
  }
});

socket.on('error', (err) => {
  console.error(`UDP error: ${err.message}`);
  process.exit(1);
});

socket.bind(port, '0.0.0.0', () => {
  console.log(`Listening on ${port} for ${seconds}s...\n`);
});

setTimeout(() => {
  socket.close();
  fs.rmSync(bundlePath, { force: true });

  console.log('Packets decoded by id:', Object.fromEntries(seen));
  console.log('\n--- ENGINEER BRIEF ---\n');
  console.log(buildEngineerBrief(builder.build()));
  process.exit(0);
}, seconds * 1000);
