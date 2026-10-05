#!/usr/bin/env node
// Fake codex for tests/codex-opinion.test.mjs. Behaves like `codex exec` as far as the
// script sees it: answers `--version`, reads the prompt from stdin and writes the last
// message to the --output-last-message file. Set by environment variables:
//   FAKE_CODEX_MODE    ok (default) | fail | empty | hang | broken (--version fails)
//   FAKE_CODEX_ANSWER  the answer to write in ok mode
//   FAKE_CODEX_LOG     file that gets one JSON line per exec call: { argv, stdin }
//   FAKE_CODEX_PID     file that gets this process id in hang mode
import { appendFileSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const mode = process.env.FAKE_CODEX_MODE || 'ok';
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
