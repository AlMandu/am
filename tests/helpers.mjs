// Shared by tests/skills.test.mjs and tests/orchestrator-skill.test.mjs: the common rules block and the slash-name rule.
import assert from 'node:assert/strict';

export const COMMON = /<!-- am:common:start -->([\s\S]*?)<!-- am:common:end -->/;
export const common = (text) => {
  const m = COMMON.exec(text);
  assert.ok(m, 'common block markers');
  return m[1];
};
export const withoutCommon = (text) => text.replace(COMMON, '');
// No g flag: .test must not keep lastIndex between calls.
export const SLASH_NAME = /(^|[^\w.])\/am[:-]/m;
