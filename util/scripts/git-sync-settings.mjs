#!/usr/bin/env node
// am-util git-sync settings: per repository, the paths that change by themselves (git-sync shows them as candidates).
// File: <CLAUDE_CONFIG_DIR or ~/.claude>/am/git-sync.json, JSON (a leading BOM is allowed):
//   { "autoChanged": { <repository folder>: [<pattern>, ...] }, "importedFromArt": { <repository folder>: [<pattern>, ...] } }
// Both keys are optional and are written under the same repository key; keys starting with `_` are notes, kept as they are.
// A broken file, an unknown key or a bad pattern is an error (one English line `<file>: <problem>`), and add / remove then
// refuse too instead of making a new file. Patterns are relative to the repository root and case-sensitive: `*` stays inside
// one folder part, `**` is zero or more parts, a trailing `/` is that whole folder, everything else is literal.
// Import from am-art: am-art 0.1.3 kept the lists in art.json (same folder) under `autoChanged`. While git-sync.json has no
// autoChanged key for a repository, list and match show the art.json list (git-sync.json is not written) and the first add or
// remove copies it in, under the lock, into both autoChanged and importedFromArt, whatever that command's result. Only
// art.json's `autoChanged` is read; keys that are not absolute paths are skipped, every key naming the same repository is
// merged without duplicates and bad patterns are dropped. A missing file, key or entry imports nothing; any other read or
// parse problem (autoChanged not an object, the entry not a list) makes add and remove fail without writing, and list and
// match warn on standard error and use git-sync.json alone. remove also records the removed pattern in importedFromArt, and
// the last removal leaves an empty list, so old patterns never come back. Once imported, list and match name on standard
// error the art.json patterns found neither in the list nor in importedFromArt. art.json is never written.
// CLI: auto list <repo>, auto add <repo> <pattern>, auto remove <repo> <pattern> (exit 3 when not listed),
//   auto match <repo> (paths on standard input, one per line; prints `<path>\t<pattern>` for each path a pattern matches).
// Exit codes: 0 done, 1 error, 2 usage, 3 not listed. Node only, no dependencies.

import { existsSync, linkSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const KEYS = ['autoChanged', 'importedFromArt'];
export const PATTERN_MAX = 200;
// A lock older than this is left over from a writer that died; rename retries cover a virus scanner holding the file.
export const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 15_000;
const RENAME_RETRY_MS = 3_000;
const READ_RETRY_MS = 3_000;
const RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNote = (k) => k.startsWith('_');
const oneLine = (s) => String(s).replace(/\s+/g, ' ').trim();
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const readText = (file) => readFileSync(file, 'utf8');

/** Path of the git-sync settings file for this environment. */
export const gitSyncSettingsFile = (env) => path.join(env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'am', 'git-sync.json');

/** The am-art settings file next to `file`, read only to import its old lists. */
const artFileNear = (file) => path.join(path.dirname(file), 'art.json');

/** Why a value is not an absolute path (its existence is not checked), or ''. */
function absoluteProblem(value) {
  if (typeof value !== 'string' || !value) return 'must be a non-empty string';
  if (CONTROL.test(value)) return 'must not hold control characters (tab, newline and the like)';
  if (!path.isAbsolute(value) || (process.platform === 'win32' && !/^([a-zA-Z]:[\\/]|\\\\)/.test(value))) return 'must be an absolute path';
  return '';
}

/** Why a value cannot be a pattern, or ''. */
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

/** The key of `obj` naming the same folder as `repo`, or undefined. */
const keyIn = (obj, repo) => {
  const want = path.resolve(repo);
  return Object.keys(obj ?? {}).find((k) => sameRepo(path.resolve(k), want));
};

/** The repository key of `repo` in both lists: an existing key naming the same folder, else `path.resolve(repo)`. */
export function repoKey(data, repo) {
  return keyIn(data.autoChanged, repo) ?? keyIn(data.importedFromArt, repo) ?? path.resolve(repo);
}

/** Reads a file whole, trying again for `retryMs` while a scanner or another process holds it (EPERM, EBUSY, EACCES). */
function readRetrying(file, readFile = readText, retryMs = READ_RETRY_MS) {
  const until = Date.now() + retryMs;
  for (;;) {
    try {
      return readFile(file, 'utf8');
    } catch (err) {
      if (!err || !RETRY_CODES.has(err.code) || Date.now() > until) throw err;
      sleep(50);
    }
  }
}

/** Checks parsed file data; returns '' or the first problem. */
function shapeProblem(data) {
  if (!isObject(data)) return 'the top level must be a JSON object';
  for (const k of Object.keys(data)) if (!KEYS.includes(k) && !isNote(k)) return `unknown key "${k}" (use ${KEYS.map((x) => `"${x}"`).join(', ')})`;
  const bad = (v) => typeof v !== 'string' || !v || CONTROL.test(v);
  for (const name of KEYS) {
    if (data[name] === undefined) continue;
    if (!isObject(data[name])) return `${name} must be an object of repository folder -> list of patterns`;
    for (const [repo, list] of Object.entries(data[name])) {
      if (bad(repo)) return `${name} repository keys must be non-empty strings without control characters`;
      if (!Array.isArray(list)) return `${name}["${repo}"] must be a list of patterns`;
      for (const p of list) {
        const problem = patternProblem(p);
        if (problem) return `${name}["${repo}"] pattern ${JSON.stringify(p)} ${problem}`;
      }
    }
  }
  return '';
}

/** Reads the file: { data } ({} when missing) or { error }. Options: `readFile`, `retryMs`. */
export function readGitSyncSettings(file, { readFile, retryMs } = {}) {
  let text;
  try {
    text = readRetrying(file, readFile, retryMs);
  } catch (err) {
    if (err && err.code === 'ENOENT') return { data: {} };
    return { error: `${file}: cannot read the file (${oneLine(err && err.message)})` };
  }
  let data;
  try {
    data = JSON.parse(String(text).replace(/^﻿/, ''));
  } catch (err) {
    return { error: `${file}: not valid JSON (${oneLine(err && err.message)})` };
  }
  const problem = shapeProblem(data);
  return problem ? { error: `${file}: ${problem}` } : { data };
}

/**
 * The old list of `repo` in am-art's art.json: { list } (empty when the file, its autoChanged or the entry is missing)
 * or { list: [], error } when it cannot be read or parsed. Never writes art.json.
 */
export function importFromArt(artFile, repo, { readFile, retryMs } = {}) {
  let text;
  try {
    text = readRetrying(artFile, readFile, retryMs);
  } catch (err) {
    if (err && err.code === 'ENOENT') return { list: [] };
    return { list: [], error: `${artFile}: cannot read the file (${oneLine(err && err.message)})` };
  }
  let data;
  try {
    data = JSON.parse(String(text).replace(/^﻿/, ''));
  } catch (err) {
    return { list: [], error: `${artFile}: not valid JSON (${oneLine(err && err.message)})` };
  }
  if (!isObject(data)) return { list: [], error: `${artFile}: the top level must be a JSON object` };
  if (data.autoChanged === undefined) return { list: [] };
  if (!isObject(data.autoChanged)) return { list: [], error: `${artFile}: autoChanged must be an object of repository folder -> list of patterns` };
  const want = path.resolve(repo);
  const list = [];
  for (const [k, v] of Object.entries(data.autoChanged)) {
    if (absoluteProblem(k) || !sameRepo(path.resolve(k), want)) continue;
    if (!Array.isArray(v)) return { list: [], error: `${artFile}: autoChanged["${k}"] must be a list of patterns` };
    for (const p of v) if (!patternProblem(p) && !list.includes(p)) list.push(p);
  }
  return { list };
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
 * Rewrites the file under a lock: re-reads it inside the lock and calls `change(data)`, which returns { error },
 * { status } (file unchanged) or { status, data } (data written). Returns { error } or { status }.
 */
function writeLocked(file, change, options = {}) {
  // Only the am folder is made, never the config folder above it.
  if (!existsSync(path.dirname(path.dirname(file)))) return { error: `${file}: the config folder does not exist` };
  try {
    mkdirSync(path.dirname(file), { recursive: true });
  } catch (e) {
    return { error: `${file}: cannot create the folder (${oneLine(e && e.message)})` };
  }
  const lock = `${file}.lock`;
  const held = takeLock(lock, options.lock);
  if (held.error) return { error: `${file}: ${held.error}` };
  const temp = `${file}.tmp-${process.pid}`;
  try {
    const read = readGitSyncSettings(file, options);
    if (read.error) return { error: `${read.error}; fix or remove the file first` };
    const r = change(read.data);
    if (r.error || !r.data) return r;
    writeFileSync(temp, `${JSON.stringify(r.data, null, 2)}\n`, 'utf8');
    if (readToken(lock) !== held.token) {
      rmSync(temp, { force: true });
      return { error: `${file}: another writer took the lock, left the file unchanged; try again` };
    }
    const renameError = renameWithRetry(temp, file);
    if (renameError) {
      rmSync(temp, { force: true });
      return { error: `${file}: could not replace the file, left it unchanged: ${renameError}` };
    }
    return { status: r.status };
  } catch (err) {
    rmSync(temp, { force: true });
    return { error: `${file}: could not write (${oneLine(err && err.message)})` };
  } finally {
    // Only this writer's own lock is removed.
    if (readToken(lock) === held.token) rmSync(lock, { force: true });
  }
}

/**
 * The list of `repo` in `data` ready to change: { key, list, record, imported } where `imported` says the art.json list was
 * just copied in (so the data must be written whatever the result), or { error } when art.json cannot be imported.
 */
function prepare(data, repo, file, options) {
  const key = repoKey(data, repo);
  const recordKey = keyIn(data.importedFromArt, repo);
  const record = recordKey === undefined ? [] : [...data.importedFromArt[recordKey]];
  if (recordKey !== undefined && recordKey !== key) {
    data.importedFromArt = { ...data.importedFromArt };
    delete data.importedFromArt[recordKey];
  }
  if (data.autoChanged && Object.hasOwn(data.autoChanged, key)) return { key, list: [...data.autoChanged[key]], record, imported: false };
  const artFile = options.artFile ?? artFileNear(file);
  const imp = importFromArt(artFile, repo, options);
  if (imp.error) return { error: `${imp.error}; ${file} was left unchanged` };
  for (const p of imp.list) if (!record.includes(p)) record.push(p);
  return { key, list: imp.list, record, imported: true };
}

const store = (data, { key, list, record }) => {
  data.autoChanged = { ...(data.autoChanged ?? {}), [key]: list };
  data.importedFromArt = { ...(data.importedFromArt ?? {}), [key]: record };
  return data;
};

/** Why `repo` cannot be a repository to add patterns for (an existing folder holding `.git`), or ''. */
function repoProblem(repo) {
  const problem = absoluteProblem(repo) || (existsSync(repo) ? '' : 'does not exist on this PC');
  if (problem) return problem;
  try {
    if (!statSync(repo).isDirectory()) return 'must be a folder, not a file';
  } catch (err) {
    return `cannot be read (${oneLine(err && err.message)})`;
  }
  if (!existsSync(path.join(repo, '.git'))) return 'is not the top folder of a git repository (no .git in it)';
  return '';
}

/**
 * Adds `pattern` to the list of `repo`: { error } or { status: 'added' | 'unchanged' }.
 * Options: `artFile`, `readFile`, `retryMs`, `lock` ({ now, staleMs, waitMs }).
 */
export function autoAdd(file, repo, pattern, options = {}) {
  const bad = repoProblem(repo);
  if (bad) return { error: `${file}: the repository ${bad}` };
  const problem = patternProblem(pattern);
  if (problem) return { error: `${file}: the pattern ${problem}` };
  return writeLocked(file, (data) => {
    const p = prepare(data, repo, file, options);
    if (p.error) return p;
    if (p.list.includes(pattern)) return p.imported ? { status: 'unchanged', data: store(data, p) } : { status: 'unchanged' };
    return { status: 'added', data: store(data, { ...p, list: [...p.list, pattern] }) };
  }, options);
}

/**
 * Removes `pattern` from the list of `repo` (an empty list stays) and records it in importedFromArt:
 * { error } or { status: 'removed' | 'missing' }. Options as for autoAdd.
 */
export function autoRemove(file, repo, pattern, options = {}) {
  const bad = absoluteProblem(repo);
  if (bad) return { error: `${file}: the repository ${bad}` };
  return writeLocked(file, (data) => {
    const p = prepare(data, repo, file, options);
    if (p.error) return p;
    if (!p.list.includes(pattern)) return p.imported ? { status: 'missing', data: store(data, p) } : { status: 'missing' };
    const record = p.record.includes(pattern) ? p.record : [...p.record, pattern];
    return { status: 'removed', data: store(data, { ...p, list: p.list.filter((x) => x !== pattern), record }) };
  }, options);
}

/**
 * The list of `repo` for list and match: { list, warning?, notice? }. Without a git-sync.json entry it is the art.json list
 * (nothing is written); with one, `notice` names the art.json patterns found neither in the list nor in importedFromArt.
 */
export function autoList(data, repo, artFile, options = {}) {
  const key = keyIn(data.autoChanged, repo);
  const imp = importFromArt(artFile, repo, options);
  if (key === undefined) return imp.error ? { list: [], warning: `warning: ${imp.error}` } : { list: imp.list };
  const list = data.autoChanged[key];
  if (imp.error) return { list };
  const recordKey = keyIn(data.importedFromArt, repo);
  const record = recordKey === undefined ? [] : data.importedFromArt[recordKey];
  const extra = imp.list.filter((p) => !list.includes(p) && !record.includes(p));
  if (!extra.length) return { list };
  return { list, notice: `notice: ${artFile} lists patterns for this repository that git-sync.json does not: ${extra.join(', ')}; add them again with auto add if still needed` };
}

/** Reads standard input whole; an empty Windows pipe reports EOF. */
function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch (err) {
    if (err && err.code === 'EOF') return '';
    throw err;
  }
}

const USAGE = 'usage: node git-sync-settings.mjs auto list <repo> | auto add <repo> <pattern> | auto remove <repo> <pattern> | auto match <repo> (paths on standard input)';

/** CLI entry; `env`, `out`, `err`, `input`, `readFile` and `retryMs` are parameters so tests need no environment variable. */
export function main(args, { env = process.env, out = (s) => process.stdout.write(s), err = (s) => process.stderr.write(s), input = readStdin, readFile, retryMs } = {}) {
  const file = gitSyncSettingsFile(env);
  const options = { readFile, retryMs };
  const usage = () => (err(`${USAGE}\n`), 2);
  const [cmd, sub, repo, pattern] = args;
  const withPattern = sub === 'add' || sub === 'remove';
  if (cmd !== 'auto' || !['list', 'add', 'remove', 'match'].includes(sub) || args.length !== (withPattern ? 4 : 3)) return usage();
  if (sub === 'add') {
    const r = autoAdd(file, repo, pattern, options);
    if (r.error) return err(`${r.error}\n`), 1;
    out(`${pattern} ${r.status === 'added' ? 'added' : 'already listed'}\n`);
    return 0;
  }
  if (sub === 'remove') {
    const r = autoRemove(file, repo, pattern, options);
    if (r.error) return err(`${r.error}\n`), 1;
    if (r.status === 'missing') return err(`${file}: ${pattern} is not listed for ${repo}\n`), 3;
    out(`${pattern} removed\n`);
    return 0;
  }
  const bad = absoluteProblem(repo);
  if (bad) return err(`${file}: the repository ${bad}\n`), 1;
  const read = readGitSyncSettings(file, options);
  if (read.error) return err(`${read.error}\n`), 1;
  const { list, warning, notice } = autoList(read.data, repo, artFileNear(file), options);
  if (warning) err(`${warning}\n`);
  if (notice) err(`${notice}\n`);
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
