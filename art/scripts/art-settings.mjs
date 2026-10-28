#!/usr/bin/env node
// am-art per-PC settings: the company values the art skills need, kept out of the public repository.
// File: <CLAUDE_CONFIG_DIR or ~/.claude>/am/art.json, JSON (a leading BOM is allowed):
//   { "adCodexRoot": <path>, "spineRoot": <path>, "python": <path>, "deployTools": { <name>: <path> }, "browserSmoke": <path>, "gameRoot": <path>,
//     "autoChanged": { <repository folder>: [<pattern>, ...] } }
// Every key is optional; keys starting with `_` are notes, kept as they are. A broken file or an unknown key is an error
// (one English line `<file>: <problem>`), and `set` then refuses too instead of making a new file.
// autoChanged lists, per repository, the paths that change by themselves (git-sync shows them as candidates). Patterns are
// relative to the repository root and case-sensitive: `*` stays inside one folder part, `**` is zero or more parts, a trailing
// `/` is that whole folder, everything else is literal. Only `auto add` and `auto remove` write it.
// CLI: get <key|deployTools.<name>> (exit 3 when missing), set <key> <value>, set deployTools.<name> <path>, show,
//   auto list <repo>, auto add <repo> <pattern>, auto remove <repo> <pattern> (exit 3 when not listed),
//   auto match <repo> (paths on standard input, one per line; prints `<path>\t<pattern>` for each path a pattern matches).
// Exit codes: 0 done, 1 error, 2 usage, 3 missing value. Node only, no dependencies.

import { existsSync, linkSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PATH_KEYS = ['adCodexRoot', 'spineRoot', 'python', 'browserSmoke', 'gameRoot'];
export const KEYS = [...PATH_KEYS, 'deployTools', 'autoChanged'];
export const PATTERN_MAX = 200;
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

/** Why a value cannot be an autoChanged pattern, or ''. */
export function patternProblem(p) {
  if (typeof p !== 'string' || !p) return 'must be a non-empty string';
  if (p.length > PATTERN_MAX) return `must be at most ${PATTERN_MAX} characters`;
  if (CONTROL.test(p)) return 'must not hold control characters';
  if (p.includes('\\')) return 'must use / between folders, not \\';
  if (p.startsWith('/')) return 'must be relative to the repository root (no leading /)';
  if (/^[A-Za-z]:/.test(p)) return 'must not start with a drive letter';
  const parts = (p.endsWith('/') ? p.slice(0, -1) : p).split('/');
  if (parts.some((s) => s === '' || s === '.' || s === '..')) return 'must not hold empty, "." or ".." folder parts';
  return '';
}

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The anchored regular expression of a pattern; runs of `*` and of `**` parts are collapsed so matching stays fast. */
function patternRegex(pattern) {
  const parts = [];
  const raw = pattern.endsWith('/') ? [...pattern.slice(0, -1).split('/'), '**'] : pattern.split('/');
  for (const part of raw) {
    const p = /^\*+$/.test(part) && part.length > 1 ? '**' : part;
    if (p !== '**' || parts[parts.length - 1] !== '**') parts.push(p);
  }
  let re = '';
  parts.forEach((p, i) => {
    const last = i === parts.length - 1;
    if (p === '**') re += last ? '[^/]+(?:/[^/]+)*' : '(?:[^/]+/)*';
    else re += p.replace(/\*+/g, '*').split('*').map(escapeRegex).join('[^/]*') + (last ? '' : '/');
  });
  return new RegExp(`^${re}$`);
}

/** A repository-relative path as the patterns see it: `/` separators, no leading `./`, no trailing carriage return. */
const normalizeRel = (rel) => rel.replace(/\r$/, '').replace(/\\/g, '/').replace(/^(?:\.\/)+/, '');

/** Whether `rel` (a path relative to the repository root) matches `pattern`. */
export function matchPattern(pattern, rel) {
  return patternRegex(pattern).test(normalizeRel(rel));
}

const sameRepo = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

/** The autoChanged key of `repo`: an existing key naming the same folder, else `path.resolve(repo)`. */
export function repoKey(data, repo) {
  const want = path.resolve(repo);
  return Object.keys(data.autoChanged ?? {}).find((k) => sameRepo(path.resolve(k), want)) ?? want;
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
  if (data.autoChanged !== undefined) {
    if (!isObject(data.autoChanged)) return 'autoChanged must be an object of repository folder -> list of patterns';
    for (const [repo, list] of Object.entries(data.autoChanged)) {
      if (bad(repo)) return 'autoChanged repository keys must be non-empty strings without control characters';
      if (!Array.isArray(list)) return `autoChanged["${repo}"] must be a list of patterns`;
      for (const p of list) {
        const problem = patternProblem(p);
        if (problem) return `autoChanged["${repo}"] pattern ${JSON.stringify(p)} ${problem}`;
      }
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

/** Sets `key` (or `deployTools.<name>`) to the path `value` under a lock. Returns '' or an error line. */
export function setArtSetting(file, key, value, lockOptions) {
  if (key === 'autoChanged') return `${file}: autoChanged is changed only with auto add / auto remove`;
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

/** Why `repo` cannot be a repository to add patterns for (an existing folder holding `.git`), or ''. */
function repoProblem(repo) {
  const problem = pathProblem(repo);
  if (problem) return problem;
  try {
    if (!statSync(repo).isDirectory()) return 'must be a folder, not a file';
  } catch (err) {
    return `cannot be read (${oneLine(err && err.message)})`;
  }
  if (!existsSync(path.join(repo, '.git'))) return 'is not the top folder of a git repository (no .git in it)';
  return '';
}

/** Adds `pattern` to the autoChanged list of `repo`: { error } or { status: 'added' | 'unchanged' }. */
export function autoAdd(file, repo, pattern, lockOptions) {
  const bad = repoProblem(repo);
  if (bad) return { error: `${file}: the repository ${bad}` };
  const problem = patternProblem(pattern);
  if (problem) return { error: `${file}: the pattern ${problem}` };
  const r = writeLocked(file, (data) => {
    const key = repoKey(data, repo);
    const list = data.autoChanged?.[key] ?? [];
    if (list.includes(pattern)) return 'unchanged';
    data.autoChanged = { ...(data.autoChanged ?? {}), [key]: [...list, pattern] };
    return data;
  }, lockOptions);
  return r.error ? r : { status: r.status ?? 'added' };
}

/** Removes `pattern` from the list of `repo` (and the key once the list is empty): { error } or { status: 'removed' | 'missing' }. */
export function autoRemove(file, repo, pattern, lockOptions) {
  const bad = absoluteProblem(repo);
  if (bad) return { error: `${file}: the repository ${bad}` };
  const r = writeLocked(file, (data) => {
    const key = repoKey(data, repo);
    const list = data.autoChanged?.[key] ?? [];
    if (!list.includes(pattern)) return 'missing';
    const rest = list.filter((p) => p !== pattern);
    const next = { ...data.autoChanged };
    if (rest.length) next[key] = rest;
    else delete next[key];
    data.autoChanged = next;
    return data;
  }, lockOptions);
  return r.error ? r : { status: r.status ?? 'removed' };
}

/** The autoChanged list of `repo` in already read data. */
export const autoList = (data, repo) => data.autoChanged?.[repoKey(data, repo)] ?? [];

/** Reads standard input whole; an empty Windows pipe reports EOF. */
function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch (err) {
    if (err && err.code === 'EOF') return '';
    throw err;
  }
}

const USAGE = 'usage: node art-settings.mjs get <key|deployTools.<name>> | set <key> <value> | set deployTools.<name> <path> | show'
  + ' | auto list <repo> | auto add <repo> <pattern> | auto remove <repo> <pattern> | auto match <repo> (paths on standard input)';

/** CLI entry; `env`, `out` and `err` are parameters so tests need no environment variable. */
export function main(args, { env = process.env, out = (s) => process.stdout.write(s), err = (s) => process.stderr.write(s), input = readStdin } = {}) {
  const file = artSettingsFile(env);
  const [cmd, key, value, ...rest] = args;
  const usage = () => (err(`${USAGE}\n`), 2);
  if (cmd === 'auto') {
    const [, sub, repo, pattern] = args;
    const withPattern = sub === 'add' || sub === 'remove';
    if (!['list', 'add', 'remove', 'match'].includes(sub) || args.length !== (withPattern ? 4 : 3)) return usage();
    if (sub === 'add') {
      const r = autoAdd(file, repo, pattern);
      if (r.error) return err(`${r.error}\n`), 1;
      out(`${pattern} ${r.status === 'added' ? 'added' : 'already listed'}\n`);
      return 0;
    }
    if (sub === 'remove') {
      const r = autoRemove(file, repo, pattern);
      if (r.error) return err(`${r.error}\n`), 1;
      if (r.status === 'missing') return err(`${file}: ${pattern} is not listed for ${repo}\n`), 3;
      out(`${pattern} removed\n`);
      return 0;
    }
    const bad = absoluteProblem(repo);
    if (bad) return err(`${file}: the repository ${bad}\n`), 1;
    const r = readArtSettings(file);
    if (r.error) return err(`${r.error}\n`), 1;
    const list = autoList(r.data, repo);
    if (sub === 'list') {
      if (list.length) out(`${list.join('\n')}\n`);
      return 0;
    }
    let text;
    try {
      text = input();
    } catch (e) {
      return err(`cannot read the paths from standard input (${oneLine(e && e.message)})\n`), 1;
    }
    const regexes = list.map((p) => [p, patternRegex(p)]);
    const hits = [];
    for (const line of String(text).split('\n')) {
      const given = line.replace(/\r$/, '');
      const rel = normalizeRel(given);
      if (!rel) continue;
      const hit = regexes.find(([, re]) => re.test(rel));
      if (hit) hits.push(`${given}\t${hit[0]}`);
    }
    if (hits.length) out(`${hits.join('\n')}\n`);
    return 0;
  }
  if (cmd === 'show' && args.length === 1) {
    const r = readArtSettings(file);
    if (r.error) return err(`${r.error}\n`), 1;
    out(`${file}\n${JSON.stringify(r.data, null, 2)}\n`);
    return 0;
  }
  if (cmd === 'get' && key && value === undefined) {
    const r = readArtSettings(file);
    if (r.error) return err(`${r.error}\n`), 1;
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
