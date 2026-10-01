// Records raw F1 25 UDP packets to a file so they can be replayed later.
//
//   node scripts/record-udp.mjs [port] [outfile]
//
// Each record is: uint32 length, float64 offset-ms, then the datagram bytes.

import dgram from 'node:dgram';
import fs from 'node:fs';
import path from 'node:path';

const port = Number(process.argv[2] ?? 20777);
const outfile = process.argv[3] ?? path.join('captures', `f1-${Date.now()}.bin`);

fs.mkdirSync(path.dirname(outfile), { recursive: true });
const out = fs.createWriteStream(outfile);

const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
const startedAt = Date.now();
let count = 0;

socket.on('message', (msg) => {
  const header = Buffer.alloc(12);
  header.writeUInt32LE(msg.length, 0);
  header.writeDoubleLE(Date.now() - startedAt, 4);
  out.write(header);
  out.write(msg);

  count++;
  if (count % 200 === 0) process.stdout.write(`\rCaptured ${count} packets`);
});

socket.on('error', (err) => {
  console.error(`\nUDP error: ${err.message}`);
  process.exit(1);
});

socket.bind(port, '0.0.0.0', () => {
  console.log(`Recording UDP ${port} to ${outfile}. Press Ctrl+C to stop.`);
});

process.on('SIGINT', () => {
  socket.close();
  out.end(() => {
    console.log(`\nSaved ${count} packets to ${outfile}`);
    process.exit(0);
  });
});
