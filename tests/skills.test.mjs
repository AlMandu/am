// Run: node --test tests/skills.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugin', 'skills');
const LIMITS = { plan: 120, check: 120, commit: 80 };
const read = (name) => readFileSync(path.join(ROOT, name, 'SKILL.md'), 'utf8');
const common = (text) => {
  const m = /<!-- am:common:start -->([\s\S]*?)<!-- am:common:end -->/.exec(text);
  assert.ok(m, 'common block markers');
  return m[1];
};

test('every skill carries the same common rules block', () => {
  const blocks = Object.keys(LIMITS).map((n) => common(read(n)));
  for (const b of blocks.slice(1)) assert.equal(b, blocks[0]);
});

test('skills stay within their line limits and name themselves after their folder', () => {
  for (const [name, limit] of Object.entries(LIMITS)) {
    const text = read(name);
    const lines = text.split('\n').length;
    assert.ok(lines <= limit, `${name}: ${lines} lines > ${limit}`);
    assert.match(text, new RegExp(`^---\\nname: ${name}\\n`), name);
    assert.match(text, /\ndescription: "[^"]{40,}"\n/, `${name} description`);
  }
});

test('am:plan is user-invoked only in both tools', () => {
  assert.match(read('plan'), /\ndisable-model-invocation: true\n/);
  const yaml = readFileSync(path.join(ROOT, 'plan', 'agents', 'openai.yaml'), 'utf8');
  assert.match(yaml, /allow_implicit_invocation: false/);
});
