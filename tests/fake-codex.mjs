#!/usr/bin/env node
// Fake codex for tests/codex-opinion.test.mjs. Behaves like `codex exec` as far as the
// script sees it: answers `--version`, reads the prompt from stdin and writes the last
// message to the --output-last-message file. Set by environment variables:
//   FAKE_CODEX_MODE    ok (default) | fail | empty | hang | broken (--version fails)
//   FAKE_CODEX_ANSWER  the answer to write in ok mode
//   FAKE_CODEX_LOG     file that gets one JSON line per exec call: { argv, stdin }
//   FAKE_CODEX_PID     file that gets this process id in hang mode and in app-server proxy mode
// `app-server proxy` acts as the proxy to a daemon: the server side of a WebSocket on stdin and
// stdout (upgrade answer, masked client frames read, answers split into two frames, a ping first),
// carrying the JSON-RPC of tests/fake-codex-daemon.mjs. Set by environment variables:
//   FAKE_CODEX_PEER    scenario file (JSON, see fake-codex-daemon.mjs); { "exitAtOnce": true } ends at once
//   FAKE_CODEX_LOG     file that gets one JSON line per message received: { rpc, params }
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { FrameReader, encodeFrame, wsAccept } from '../plugin/scripts/codex-opinion.mjs';
import { createDaemon } from './fake-codex-daemon.mjs';

const argv = process.argv.slice(2);
const mode = process.env.FAKE_CODEX_MODE || 'ok';
if (argv[0] === 'app-server' && argv[1] === 'proxy') proxy();
else exec();

function proxy() {
  if (process.env.FAKE_CODEX_PID) writeFileSync(process.env.FAKE_CODEX_PID, String(process.pid));
  const scenario = JSON.parse(readFileSync(process.env.FAKE_CODEX_PEER, 'utf8'));
  if (scenario.exitAtOnce) {
    process.stderr.write('error: no Codex daemon is running\n');
    process.exit(1);
  }
  const log = (entry) => process.env.FAKE_CODEX_LOG && appendFileSync(process.env.FAKE_CODEX_LOG, `${JSON.stringify({ rpc: entry.method, params: entry.params })}\n`);
  const daemon = createDaemon(scenario, { onLog: log });
  const reader = new FrameReader();
  // A text message in two frames: the client has to join fragments.
  const send = (text) => {
    const data = Buffer.from(text, 'utf8');
    const cut = Math.floor(data.length / 2);
    const first = encodeFrame(1, data.subarray(0, cut));
    first[0] &= 0x7f; // FIN off
    const rest = encodeFrame(0, data.subarray(cut));
    process.stdout.write(Buffer.concat([first, rest]));
  };
  let head = Buffer.alloc(0);
  process.stdin.on('data', (chunk) => {
    if (head !== null) {
      head = Buffer.concat([head, chunk]);
      const i = head.indexOf('\r\n\r\n');
      if (i < 0) return;
      const key = /^sec-websocket-key:\s*(.+)$/im.exec(head.subarray(0, i).toString('latin1'))?.[1]?.trim() ?? '';
      const rest = head.subarray(i + 4);
      head = null;
      process.stdout.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${wsAccept(key)}\r\n\r\n`);
      process.stdout.write(encodeFrame(9, 'are you there'));
      chunk = rest;
    }
    for (const e of reader.push(chunk)) {
      if (e.type === 'text') daemon.receive(e.data, send);
      else if (e.type === 'ping') process.stdout.write(encodeFrame(10, e.data));
      else if (e.type === 'pong' && process.env.FAKE_CODEX_LOG) appendFileSync(process.env.FAKE_CODEX_LOG, `${JSON.stringify({ pong: e.data.toString('utf8') })}\n`);
      else if (e.type === 'close') {
        process.stdout.write(encodeFrame(8, Buffer.alloc(0)));
        process.exit(0);
      }
    }
  });
  setInterval(() => {}, 1000); // a real proxy stays until it is ended
}

function exec() {
  if (argv.includes('--version')) {
    if (mode === 'broken') {
      process.stderr.write('codex: cannot load config\n');
      process.exit(1);
    }
    process.stdout.write('codex-cli 0.160.0 (fake)\n');
    process.exit(0);
  }

  let stdin = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => (stdin += d));
  process.stdin.on('end', () => {
    if (process.env.FAKE_CODEX_LOG) appendFileSync(process.env.FAKE_CODEX_LOG, `${JSON.stringify({ argv, stdin })}\n`);
    process.stderr.write('[fake] reading files...\n');
    process.stdout.write('progress that the script must not print\n');
    if (mode === 'hang') {
      if (process.env.FAKE_CODEX_PID) writeFileSync(process.env.FAKE_CODEX_PID, String(process.pid));
      setInterval(() => {}, 1000);
      return;
    }
    if (mode === 'fail') {
      process.stderr.write('error: not logged in\n');
      process.exit(3);
    }
    const i = argv.indexOf('--output-last-message');
    if (mode === 'ok' && i >= 0) writeFileSync(argv[i + 1], process.env.FAKE_CODEX_ANSWER || 'Choice 1: A\nWhy: fake.\nRisk: none\n');
    process.exit(0);
  });
}
