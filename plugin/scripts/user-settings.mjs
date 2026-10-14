// am user settings: the per-PC file for settings that hold for every am run on this PC.
// File: <CLAUDE_CONFIG_DIR or ~/.claude>/am/settings.json, JSON (a leading BOM is allowed):
//   { "minFreeMemoryMB": <number or null>, "stageMcpServers": <true, false or null> }
// minFreeMemoryMB is null (or missing) for the built-in value, else a finite number of 0 or more.
// stageMcpServers is true to let am:auto stage sessions start MCP servers; null, false or missing keeps them off.
// Keys starting with `_` are notes, allowed at the top, and dropped from the result.
// A broken file is an error (one English line `<file>: <problem>`), never a silent fallback.
// Reads no environment variable itself (the caller passes env). Node only, no dependencies.

import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNote = (k) => k.startsWith('_');
const KEYS = ['minFreeMemoryMB', 'stageMcpServers'];
const oneLine = (s) => String(s).replace(/\s+/g, ' ').trim();

/** Path of the user settings file for this environment. */
export const userSettingsFile = (env) => path.join(env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'am', 'settings.json');

/**
 * Reads and checks the user settings file: { minFreeMemoryMB, stageMcpServers } (null when the file or key is missing),
 * or { error } at the first problem (any read error other than a missing file counts).
 */
export function readUserSettings(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return { minFreeMemoryMB: null, stageMcpServers: null };
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
  for (const k of Object.keys(data)) if (!KEYS.includes(k) && !isNote(k)) return fail(`unknown key "${k}" (use "minFreeMemoryMB" or "stageMcpServers")`);
  const v = data.minFreeMemoryMB;
  if (v !== undefined && v !== null && !(typeof v === 'number' && Number.isFinite(v) && v >= 0)) {
    return fail(`minFreeMemoryMB must be null or a finite number of 0 or more (got ${JSON.stringify(v)})`);
  }
  const m = data.stageMcpServers;
  if (m !== undefined && m !== null && typeof m !== 'boolean') return fail(`stageMcpServers must be null, true or false (got ${JSON.stringify(m)})`);
  return { minFreeMemoryMB: v ?? null, stageMcpServers: m ?? null };
}
