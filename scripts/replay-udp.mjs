// Feeds the app telemetry without the game running.
//
//   node scripts/replay-udp.mjs                 -> synthetic race (default)
//   node scripts/replay-udp.mjs captures/x.bin  -> replay a real capture
//
// Useful for building and testing on a machine that cannot run F1 25.

import dgram from 'node:dgram';
import fs from 'node:fs';

const HOST = '127.0.0.1';
const PORT = Number(process.env.UDP_PORT ?? 20777);
const MAX_CARS = 22;
const HEADER_SIZE = 29;

const socket = dgram.createSocket('udp4');
const file = process.argv[2];

if (file) {
  replayCapture(file);
} else {
  runSyntheticRace();
}

function replayCapture(pathname) {
  const data = fs.readFileSync(pathname);
  console.log(`Replaying ${pathname} to ${HOST}:${PORT}`);

  const packets = [];
  let offset = 0;
  while (offset + 12 <= data.length) {
    const length = data.readUInt32LE(offset);
    const at = data.readDoubleLE(offset + 4);
    offset += 12;
    if (offset + length > data.length) break;
    packets.push({ at, buf: data.subarray(offset, offset + length) });
    offset += length;
  }

  console.log(`${packets.length} packets loaded.`);
  const startedAt = Date.now();
  let index = 0;

  const pump = () => {
    const elapsed = Date.now() - startedAt;
    while (index < packets.length && packets[index].at <= elapsed) {
      socket.send(packets[index].buf, PORT, HOST);
      index++;
    }
    if (index >= packets.length) {
      console.log('Replay finished.');
      socket.close();
      return;
    }
    setTimeout(pump, 4);
  };
  pump();
}

function writeHeader(buf, packetId, sessionTime, frame) {
  buf.writeUInt16LE(2025, 0);
  buf.writeUInt8(25, 2);
  buf.writeUInt8(1, 3);
  buf.writeUInt8(0, 4);
  buf.writeUInt8(1, 5);
  buf.writeUInt8(packetId, 6);
  buf.writeBigUInt64LE(1234567890123n, 7);
  buf.writeFloatLE(sessionTime, 15);
  buf.writeUInt32LE(frame, 19);
  buf.writeUInt32LE(frame, 23);
  buf.writeUInt8(0, 27);
  buf.writeUInt8(255, 28);
}

function packet(packetId, bodySize, sessionTime, frame) {
  const buf = Buffer.alloc(HEADER_SIZE + bodySize);
  writeHeader(buf, packetId, sessionTime, frame);
  return buf;
}

function runSyntheticRace() {
  console.log(`Sending a synthetic F1 25 race to ${HOST}:${PORT}. Ctrl+C to stop.`);

  const TOTAL_LAPS = 25;
  const LAP_SECONDS = 92;
  let t = 0;
  let frame = 0;

  const send = (buf) => socket.send(buf, PORT, HOST);

  // 60Hz car state.
  setInterval(() => {
    t += 1 / 60;
    frame++;

    const lapProgress = (t % LAP_SECONDS) / LAP_SECONDS;
    const lapNum = Math.min(TOTAL_LAPS, Math.floor(t / LAP_SECONDS) + 1);
    const tyreAge = lapNum - 1;
    const wave = Math.sin(lapProgress * Math.PI * 6);

    // Car telemetry.
    {
      const buf = packet(6, MAX_CARS * 60 + 3, t, frame);
      for (let car = 0; car < MAX_CARS; car++) {
        const at = HEADER_SIZE + car * 60;
        const speed = Math.round(180 + wave * 110);
        buf.writeUInt16LE(Math.max(60, speed), at);
        buf.writeFloatLE(wave > 0 ? 1 : 0.2, at + 2);
        buf.writeFloatLE(wave * 0.4, at + 6);
        buf.writeFloatLE(wave > 0 ? 0 : 0.6, at + 10);
        buf.writeInt8(Math.max(1, Math.min(8, Math.round(4 + wave * 4))), at + 15);
        buf.writeUInt16LE(Math.round(9000 + wave * 3000), at + 16);
        buf.writeUInt8(lapProgress > 0.3 && lapProgress < 0.45 ? 1 : 0, at + 18);
        for (let w = 0; w < 4; w++) {
          buf.writeUInt16LE(Math.round(420 + wave * 180), at + 22 + w * 2);
          buf.writeUInt8(Math.round(96 + w * 3 + wave * 6), at + 30 + w);
          buf.writeUInt8(Math.round(104 + w * 3), at + 34 + w);
          buf.writeFloatLE(23.5 + w * 0.2, at + 40 + w * 4);
        }
        buf.writeUInt16LE(110, at + 38);
      }
      send(buf);
    }

    // Car status.
    {
      const buf = packet(7, MAX_CARS * 55, t, frame);
      for (let car = 0; car < MAX_CARS; car++) {
        const at = HEADER_SIZE + car * 55;
        buf.writeUInt8(1, at + 2);
        buf.writeUInt8(58, at + 3);
        buf.writeFloatLE(Math.max(0.5, 40 - t * 0.012), at + 5);
        buf.writeFloatLE(110, at + 9);
        buf.writeFloatLE(1.2 - lapNum * 0.03, at + 13);
        buf.writeUInt16LE(13000, at + 17);
        buf.writeUInt8(lapProgress > 0.3 && lapProgress < 0.45 ? 1 : 0, at + 22);
        buf.writeUInt16LE(lapProgress > 0.2 && lapProgress < 0.3 ? 340 : 0, at + 23);
        buf.writeUInt8(car === 0 ? 16 : 17, at + 25);
        buf.writeUInt8(car === 0 ? 16 : 17, at + 26);
        buf.writeUInt8(tyreAge, at + 27);
        buf.writeInt8(0, at + 28);
        buf.writeFloatLE(4_000_000 * (0.35 + 0.5 * Math.abs(Math.cos(lapProgress * Math.PI * 2))), at + 37);
        buf.writeUInt8(1, at + 41);
        buf.writeFloatLE(1_200_000, at + 42);
        buf.writeFloatLE(400_000, at + 46);
        buf.writeFloatLE(2_100_000 * lapProgress, at + 50);
      }
      send(buf);
    }

    // Lap data.
    {
      const buf = packet(2, MAX_CARS * 57 + 2, t, frame);
      for (let car = 0; car < MAX_CARS; car++) {
        const at = HEADER_SIZE + car * 57;
        const position = car + 1 === 1 ? 1 : car + 1;
        buf.writeUInt32LE(91_400 + car * 220, at);
        buf.writeUInt32LE(Math.round(lapProgress * LAP_SECONDS * 1000), at + 4);
        buf.writeUInt16LE(28_400, at + 8);
        buf.writeUInt16LE(31_100, at + 11);
        // Player sits P4 with a car 1.4s up the road and one 0.8s behind.
        const gapMs = car === 0 ? 1400 : car === 4 ? 800 : 2000 + car * 500;
        buf.writeUInt16LE(gapMs % 60000, at + 14);
        buf.writeUInt8(Math.floor(gapMs / 60000), at + 16);
        buf.writeUInt16LE((3200 + car * 900) % 60000, at + 17);
        buf.writeFloatLE(lapProgress * 5891, at + 20);
        buf.writeUInt8(car === 0 ? 4 : position, at + 32);
        buf.writeUInt8(lapNum, at + 33);
        buf.writeUInt8(0, at + 34);
        buf.writeUInt8(lapNum > 12 ? 1 : 0, at + 35);
        buf.writeUInt8(lapProgress < 0.33 ? 0 : lapProgress < 0.66 ? 1 : 2, at + 36);
        buf.writeUInt8(4, at + 44);
        buf.writeUInt8(2, at + 45);
        buf.writeFloatLE(318, at + 52);
      }
      send(buf);
    }
  }, 1000 / 60);

  // Car damage at 5Hz.
  setInterval(() => {
    const lapNum = Math.floor(t / LAP_SECONDS) + 1;
    const buf = packet(10, MAX_CARS * 46, t, frame);
    for (let car = 0; car < MAX_CARS; car++) {
      const at = HEADER_SIZE + car * 46;
      for (let w = 0; w < 4; w++) {
        const wear = Math.min(95, lapNum * 2.4 + w * 1.5 + (w > 1 ? 3 : 0));
        buf.writeFloatLE(wear, at + w * 4);
        buf.writeUInt8(0, at + 16 + w);
        buf.writeUInt8(0, at + 20 + w);
      }
      buf.writeUInt8(car === 0 ? 4 : 0, at + 28);
    }
    send(buf);
  }, 200);

  // Session at 2Hz.
  setInterval(() => {
    const buf = packet(1, 724, t, frame);
    const b = HEADER_SIZE;
    buf.writeUInt8(1, b);
    buf.writeInt8(38, b + 1);
    buf.writeInt8(26, b + 2);
    buf.writeUInt8(TOTAL_LAPS, b + 3);
    buf.writeUInt16LE(5891, b + 4);
    buf.writeUInt8(15, b + 6);
    buf.writeInt8(7, b + 7);
    buf.writeUInt16LE(Math.max(0, Math.round(TOTAL_LAPS * LAP_SECONDS - t)), b + 9);
    buf.writeUInt16LE(TOTAL_LAPS * LAP_SECONDS, b + 11);
    buf.writeUInt8(80, b + 13);
    buf.writeUInt8(21, b + 18);
    buf.writeUInt8(0, b + 19 + 21 * 5);
    buf.writeUInt8(3, b + 126);
    // Rain builds through the race so the engineer has something to warn about.
    const samples = [
      { offset: 5, weather: 1, rain: 10 },
      { offset: 15, weather: 2, rain: 35 },
      { offset: 30, weather: 3, rain: 65 },
    ];
    samples.forEach((sample, i) => {
      const at = b + 127 + i * 8;
      buf.writeUInt8(15, at);
      buf.writeUInt8(sample.offset, at + 1);
      buf.writeUInt8(sample.weather, at + 2);
      buf.writeInt8(38, at + 3);
      buf.writeInt8(26, at + 5);
      buf.writeUInt8(sample.rain, at + 7);
    });
    buf.writeUInt8(14, b + 653);
    buf.writeUInt8(18, b + 654);
    buf.writeUInt8(6, b + 655);
    send(buf);
  }, 500);

  // Participants at 0.5Hz.
  const names = [
    'YOU', 'VERSTAPPEN', 'NORRIS', 'LECLERC', 'HAMILTON', 'RUSSELL', 'PIASTRI', 'SAINZ',
    'ALONSO', 'PEREZ', 'STROLL', 'GASLY', 'OCON', 'ALBON', 'TSUNODA', 'HULKENBERG',
    'MAGNUSSEN', 'RICCIARDO', 'BOTTAS', 'ZHOU', 'SARGEANT', 'LAWSON',
  ];
  setInterval(() => {
    const buf = packet(4, 1 + MAX_CARS * 57, t, frame);
    buf.writeUInt8(MAX_CARS, HEADER_SIZE);
    for (let car = 0; car < MAX_CARS; car++) {
      const at = HEADER_SIZE + 1 + car * 57;
      buf.writeUInt8(car === 0 ? 0 : 1, at);
      buf.writeUInt8(car % 10, at + 3);
      buf.writeUInt8(car + 1, at + 5);
      buf.write(names[car], at + 7, 31, 'utf8');
      buf.writeUInt8(0, at + 7 + names[car].length);
    }
    send(buf);
  }, 2000);

  process.on('SIGINT', () => {
    socket.close();
    process.exit(0);
  });
}
