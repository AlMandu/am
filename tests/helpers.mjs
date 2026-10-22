// Shared by tests/skills.test.mjs, tests/orchestrator-skill.test.mjs and tests/stage.test.mjs: the common rules block,
// the slash-name rule and a skill's text with the flow files it reads.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const COMMON = /<!-- am:common:start -->([\s\S]*?)<!-- am:common:end -->/;
export const common = (text) => {
  const m = COMMON.exec(text);
  assert.ok(m, 'common block markers');
  return m[1];
};
export const withoutCommon = (text) => text.replace(COMMON, '');
// No g flag: .test must not keep lastIndex between calls.
export const SLASH_NAME = /(^|[^\w.])\/am[:-]/m;
// The flow files a SKILL.md names, in order of first mention; the folder is flow/ under its plugin root.
export const FLOW_NAME = /\$\{CLAUDE_PLUGIN_ROOT\}\/flow\/([a-z-]+\.md)/g;
export const flowNames = (text) => [...new Set([...text.matchAll(FLOW_NAME)].map((m) => m[1]))];
/** A SKILL.md's text followed by each flow file it names, as the skill reads them at run time. */
export function withFlow(skillFile) {
  const text = readFileSync(skillFile, 'utf8');
  const dir = path.resolve(path.dirname(skillFile), '..', '..', 'flow');
  return [text, ...flowNames(text).map((name) => {
    const file = path.join(dir, name);
    assert.ok(existsSync(file), `${skillFile} names flow/${name}`);
    return readFileSync(file, 'utf8');
  })].join('\n');
}
