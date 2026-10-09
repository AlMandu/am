// am user models: the per-PC file where a person picks the model and effort of each am stage.
// File: <CLAUDE_CONFIG_DIR or ~/.claude>/am/models.json, JSON (a leading BOM is allowed):
//   { "model": { "<key>": "<model>" }, "effort": { "<key>": "<effort>" } }
// Keys: default, plan, do, check, compactmem, commit, compact, run, split. Keys starting with `_`
// are notes, allowed at the top and inside model/effort, and dropped from the result.
// Order per stage, model and effort apart: the stage's key, then default, then the built-in value.
// A broken file is an error (one English line `<file>: <problem>`), never a silent fallback.
// Reads no environment variable itself (the caller passes env). Node only, no dependencies.

import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const USER_MODEL_KEYS = ['default', 'plan', 'do', 'check', 'compactmem', 'commit', 'compact', 'run', 'split'];
export const USER_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNote = (k) => k.startsWith('_');
const oneLine = (s) => String(s).replace(/\s+/g, ' ').trim();

/** Path of the user models file for this environment. */
export const userModelsFile = (env) => path.join(env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'am', 'models.json');

/**
 * Reads and checks the user models file: { model, effort } without notes, empty when the file is missing,
 * or { error } at the first problem (any read error other than a missing file counts).
 */
export function readUserModels(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return { model: {}, effort: {} };
    return { error: `${file}: cannot read the file (${oneLine(err && err.message)})` };
  }
  let data;
  try {
    data = JSON.parse(text.replace(/^﻿/, ''));
  } catch (err) {
    return { error: `${file}: not valid JSON (${oneLine(err && err.message)})` };
  }
  const fail = (problem) => ({ error: `${file}: ${problem}` });
  if (!isObject(data)) return fail('the top level must be a JSON object');
  for (const k of Object.keys(data)) if (k !== 'model' && k !== 'effort' && !isNote(k)) return fail(`unknown key "${k}" (use "model" or "effort")`);
  const result = {};
  for (const part of ['model', 'effort']) {
    const section = data[part] === undefined ? {} : data[part];
    if (!isObject(section)) return fail(`"${part}" must be a JSON object of stage keys`);
    result[part] = {};
    for (const [k, v] of Object.entries(section)) {
      if (isNote(k)) continue;
      if (!USER_MODEL_KEYS.includes(k)) return fail(`unknown key "${part}.${k}" (${k === 'implement' ? 'use "do"' : `use one of ${USER_MODEL_KEYS.join(', ')}`})`);
      if (part === 'model' && (typeof v !== 'string' || !v.trim())) return fail(`model.${k} must be a non-empty string (got ${JSON.stringify(v)})`);
      if (part === 'effort' && !USER_EFFORTS.includes(v)) return fail(`effort.${k} must be one of ${USER_EFFORTS.join(', ')} (got ${JSON.stringify(v)})`);
      result[part][k] = v;
    }
  }
  return result;
}

/** Model and effort of one stage key: the key's value, then default, then builtin, each decided apart. */
export const resolveUser = (cfg, key, builtin) => ({
  model: cfg.model[key] ?? cfg.model.default ?? builtin.model,
  effort: cfg.effort[key] ?? cfg.effort.default ?? builtin.effort,
});
