#!/usr/bin/env node
// am-art per-PC settings: the company values the art skills need, kept out of the public repository.
// File: <CLAUDE_CONFIG_DIR or ~/.claude>/am/art.json, JSON (a leading BOM is allowed):
//   { "adCodexRoot": <path>, "spineRoot": <path>, "python": <path>, "deployTools": { <name>: <path> }, "browserSmoke": <path>, "gameRoot": <path>,
//     "autoChanged": { <repository folder>: [<pattern>, ...] } }
// Every key is optional; keys starting with `_` are notes, kept as they are. A broken file or an unknown key is an error
// (one English line `<file>: <problem>`), and `set` then refuses too instead of making a new file.
// autoChanged is the old list am-art 0.1.3 wrote (repository folder -> patterns). This script only reads it and leaves it as it
// is on `set`; it never writes it. am-util's git-sync-settings.mjs imports it into git-sync.json.
// CLI: get <key|deployTools.<name>> (exit 3 when missing), set <key> <value>, set deployTools.<name> <path>, show.
// Exit codes: 0 done, 1 error, 2 usage, 3 missing value. Node only, no dependencies.

import { existsSync, linkSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PATH_KEYS = ['adCodexRoot', 'spineRoot', 'python', 'browserSmoke', 'gameRoot'];
export const KEYS = [...PATH_KEYS, 'deployTools', 'autoChanged'];
// A lock older than this is left over from a writer that died; rename retries cover a virus scanner holding the file.
export const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 15_000;
const RENAME_RETRY_MS = 3_000;
const RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNote = (k) => k.startsWith('_');
const oneLine = (s) => String(s).replace(/\s+/g, ' ').trim();
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Path of the art settings file for this environment. */
export const artSettingsFile = (env) => path.join(env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'am', 'art.json');

/** Why a value cannot be stored as a path, or '' when it can. */
export function pathProblem(value) {
  return absoluteProblem(value) || (existsSync(value) ? '' : 'does not exist on this PC');
}

/** Why a value is not an absolute path (its existence is not checked), or ''. */
function absoluteProblem(value) {
  if (typeof value !== 'string' || !value) return 'must be a non-empty string';
  if (CONTROL.test(value)) return 'must not hold control characters (tab, newline and the like)';
  if (!path.isAbsolute(value) || (process.platform === 'win32' && !/^([a-zA-Z]:[\\/]|\\\\)/.test(value))) return 'must be an absolute path';
  return '';
}

/** Checks parsed file data; returns '' or the first problem. Existence is checked only when a value is set. */
function shapeProblem(data) {
  if (!isObject(data)) return 'the top level must be a JSON object';
  for (const k of Object.keys(data)) if (!KEYS.includes(k) && !isNote(k)) return `unknown key "${k}" (use ${KEYS.map((x) => `"${x}"`).join(', ')})`;
  const bad = (v) => typeof v !== 'string' || !v || CONTROL.test(v);
  for (const k of PATH_KEYS) if (data[k] !== undefined && bad(data[k])) return `${k} must be a non-empty string without control characters`;
  if (data.deployTools !== undefined) {
    if (!isObject(data.deployTools)) return 'deployTools must be an object of name -> path';
    for (const [n, v] of Object.entries(data.deployTools)) if (bad(v)) return `deployTools.${n} must be a non-empty string without control characters`;
  }
  // The old am-art 0.1.3 list: only its shape is checked, never the pattern syntax (am-util:git-sync checks that on import).
  if (data.autoChanged !== undefined) {
    if (!isObject(data.autoChanged)) return 'autoChanged must be an object of repository folder -> list of patterns';
    for (const [repo, list] of Object.entries(data.autoChanged)) {
      if (bad(repo)) return 'autoChanged repository keys must be non-empty strings without control characters';
      if (!Array.isArray(list) || list.some((p) => typeof p !== 'string')) return `autoChanged["${repo}"] must be a list of strings`;
    }
  }
  return '';
}

/** Reads the file: { data } ({} when missing) or { error }. */
export function readArtSettings(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return { data: {} };
    return { error: `${file}: cannot read the file (${oneLine(err && err.message)})` };
  }
  let data;
  try {
    data = JSON.parse(text.replace(/^﻿/, ''));
  } catch (err) {
    return { error: `${file}: not valid JSON (${oneLine(err && err.message)})` };
  }
  const problem = shapeProblem(data);
  return problem ? { error: `${file}: ${problem}` } : { data };
}

/** { value } of `key` or `deployTools.<name>` (`undefined` when unset), or { error } for an unknown key. */
export function lookup(data, key) {
  const m = /^deployTools\.(.+)$/.exec(key);
  if (m) return { value: data.deployTools?.[m[1]] };
  if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
  return { value: data[key] };
}

const readToken = (file) => {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
};

/** Takes the lock: { token } (the lock's content, unique to this writer) or { error }. */
function takeLock(lock, { now = Date.now, staleMs = LOCK_STALE_MS, waitMs = LOCK_WAIT_MS } = {}) {
  const until = now() + waitMs;
  const token = `${process.pid}-${Math.random().toString(36).slice(2)}`;
  for (;;) {
    try {
      writeFileSync(lock, token, { flag: 'wx' });
      return { token };
    } catch (err) {
      if (err.code !== 'EEXIST') return { error: `cannot create the lock ${lock} (${oneLine(err.message)})` };
    }
    try {
      // An old lock is moved aside and checked again: a fresh lock moved by mistake goes back (link never replaces one).
      if (now() - statSync(lock).mtimeMs > staleMs) {
        const taken = `${lock}.stale-${token}`;
        renameSync(lock, taken);
        if (now() - statSync(taken).mtimeMs <= staleMs) {
          try {
            linkSync(taken, lock);
          } catch {
            // a newer lock already stands; its owner keeps it
          }
        }
        rmSync(taken, { force: true });
        continue;
      }
    } catch {
      continue;
    }
    if (now() > until) return { error: `another writer holds ${lock}; try again` };
    sleep(50);
  }
}

function renameWithRetry(from, to) {
  const until = Date.now() + RENAME_RETRY_MS;
  for (;;) {
    try {
      renameSync(from, to);
      return '';
    } catch (err) {
      if (!RETRY_CODES.has(err.code) || Date.now() > until) return `${err.code || 'error'} (${oneLine(err.message)})`;
      sleep(100);
    }
  }
}

/**
 * Rewrites the file under a lock: re-reads it inside the lock and calls `change(data)`, which returns the data to write
 * or a status string to leave the file unchanged. Returns { error }, { status } (unchanged) or {} (written).
 */
function writeLocked(file, change, lockOptions) {
  // Only the am folder is made, never the config folder above it.
  if (!existsSync(path.dirname(path.dirname(file)))) return { error: `${file}: the config folder does not exist` };
  try {
    mkdirSync(path.dirname(file), { recursive: true });
  } catch (e) {
    return { error: `${file}: cannot create the folder (${oneLine(e && e.message)})` };
  }
  const lock = `${file}.lock`;
  const held = takeLock(lock, lockOptions);
  if (held.error) return { error: `${file}: ${held.error}` };
  const temp = `${file}.tmp-${process.pid}`;
  try {
    const read = readArtSettings(file);
    if (read.error) return { error: `${read.error}; fix or remove the file first` };
    const data = change(read.data);
    if (typeof data === 'string') return { status: data };
    writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    if (readToken(lock) !== held.token) {
      rmSync(temp, { force: true });
      return { error: `${file}: another writer took the lock, left the file unchanged; try again` };
    }
    const renameError = renameWithRetry(temp, file);
    if (renameError) {
      rmSync(temp, { force: true });
      return { error: `${file}: could not replace the file, left it unchanged: ${renameError}` };
    }
    return {};
  } catch (err) {
    rmSync(temp, { force: true });
    return { error: `${file}: could not write (${oneLine(err && err.message)})` };
  } finally {
    // Only this writer's own lock is removed.
    if (readToken(lock) === held.token) rmSync(lock, { force: true });
  }
}

/** The one line `get` and `set` give for autoChanged, which moved to am-util:git-sync. */
const movedLine = (file) => `${file}: autoChanged moved to am-util:git-sync (git-sync.json); this file keeps only the old am-art 0.1.3 list, which git-sync imports by itself`;

/** Sets `key` (or `deployTools.<name>`) to the path `value` under a lock. Returns '' or an error line. */
export function setArtSetting(file, key, value, lockOptions) {
  if (key === 'autoChanged') return movedLine(file);
  const tool = /^deployTools\.(.+)$/.exec(key);
  if (!tool && !PATH_KEYS.includes(key)) return `${file}: unknown key "${key}" (use ${PATH_KEYS.join(', ')} or deployTools.<name>)`;
  if (tool && CONTROL.test(tool[1])) return `${file}: the tool name must not hold control characters`;
  const problem = pathProblem(value);
  if (problem) return `${file}: ${key} ${problem}`;
  const r = writeLocked(file, (data) => {
    if (tool) data.deployTools = { ...(data.deployTools ?? {}), [tool[1]]: value };
    else data[key] = value;
    return data;
  }, lockOptions);
  return r.error ?? '';
}

const USAGE = 'usage: node art-settings.mjs get <key|deployTools.<name>> | set <key> <value> | set deployTools.<name> <path> | show';

/** CLI entry; `env`, `out` and `err` are parameters so tests need no environment variable. */
export function main(args, { env = process.env, out = (s) => process.stdout.write(s), err = (s) => process.stderr.write(s) } = {}) {
  const file = artSettingsFile(env);
  const [cmd, key, value, ...rest] = args;
  const usage = () => (err(`${USAGE}\n`), 2);
  if (cmd === 'show' && args.length === 1) {
    const r = readArtSettings(file);
    if (r.error) return err(`${r.error}\n`), 1;
    out(`${file}\n${JSON.stringify(r.data, null, 2)}\n`);
    if (r.data.autoChanged !== undefined) err('note: autoChanged here is the old am-art 0.1.3 list; am-util:git-sync keeps the live list in git-sync.json\n');
    return 0;
  }
  if (cmd === 'get' && key && value === undefined) {
    const r = readArtSettings(file);
    if (r.error) return err(`${r.error}\n`), 1;
    if (key === 'autoChanged') return err(`${movedLine(file)}\n`), 1;
    const { value: v, error } = lookup(r.data, key);
    if (error) return err(`${file}: ${error}\n`), 1;
    if (v === undefined) return err(`${file}: ${key} is not set\n`), 3;
    out(`${typeof v === 'string' ? v : JSON.stringify(v)}\n`);
    return 0;
  }
  if (cmd === 'set' && key && value !== undefined && !rest.length) {
    const e = setArtSetting(file, key, value);
    if (e) return err(`${e}\n`), 1;
    out(`${key} = ${value}\n`);
    return 0;
  }
  return usage();
}

const real = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return '';
  }
};
const self = real(fileURLToPath(import.meta.url));
const invoked = process.argv[1] ? real(path.resolve(process.argv[1])) : '';
if (invoked && (process.platform === 'win32' ? invoked.toLowerCase() === self.toLowerCase() : invoked === self)) process.exitCode = main(process.argv.slice(2));
