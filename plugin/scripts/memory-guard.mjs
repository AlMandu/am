// am memory guard: the free-memory rule and the session records shared with am-orchestrator.
// Records live in <CLAUDE_CONFIG_DIR or ~/.claude>/am-orchestrator/sessions/ as <host>~<pid>~<n>.gate.json;
// the orchestrator counts `.gate` records only in its memory check, never against its session limit.
// The rules copy orchestrator/scripts/orchestrator.mjs (memoryShortMB, recordHeld, folder, name, host, times);
// tests/orchestrator-skill.test.mjs compares both copies on the same inputs.
// Reads no environment variable itself (the caller passes env or dir). Node only, no dependencies.

import { mkdirSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_MIN_FREE_MEMORY_MB = 6144;
// The owner touches its record every 30 seconds; a record untouched for 5 minutes has lost its owner
export const HEARTBEAT_MS = 30000;
export const STALE_MS = 5 * 60000;
// No flags: exec keeps no state between calls
export const RECORD_NAME = /^(.+)~(\d+)~\d+(\.gate)?\.json$/;

/**
 * { freeMB, needMB } when a new session should wait for memory, else null. busy counts the live records other than the caller's.
 * setting (minFreeMemoryMB): null, missing, blank or invalid is the built-in value (win32 only), 0 is off, a number is that value on every OS.
 */
export function memoryShortMB({ busy, freeBytes, setting, platform }) {
  let needMB = DEFAULT_MIN_FREE_MEMORY_MB;
  let custom = false;
  if (typeof setting === 'number' || (typeof setting === 'string' && setting.trim() !== '')) {
    const n = Number(setting);
    if (Number.isFinite(n) && n >= 0) [needMB, custom] = [n, true];
  }
  if (busy <= 0 || needMB === 0 || (!custom && platform !== 'win32')) return null;
  const freeMB = Math.floor(freeBytes / 1048576);
  return freeMB < needMB ? { freeMB, needMB } : null;
}

/**
 * Whether a record still holds its place. Not when the host matches and the pid is dead (a pid on another host cannot be checked).
 * Not when untouched for staleMs, unless this process just woke (woke). A young process cannot tell whether the PC just woke,
 * so a same-host record with a live pid holds until its owner touches it once.
 */
export function recordHeld({ host, pid, mtimeMs }, { now, myHost, alive, woke = false, young = false, staleMs = STALE_MS }) {
  if (host === myHost) {
    if (!alive(pid)) return false;
    if (young) return true;
  }
  return woke || now - mtimeMs <= staleMs;
}

/** The record folder for this environment. */
export const sessionsDirOf = (env) => path.join(env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'am-orchestrator', 'sessions');
// Read on every call: macOS changes the host name with the network
export const hostName = () => os.hostname().replace(/[^\w.-]/g, '_') || 'host';

const pidAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM'; // the process exists but may not be signalled
  }
};

const held = new Map(); // records this process holds: file -> state
const leftover = new Set(); // released records that could not be removed (Windows antivirus); not counted, removed again later
let seq = 0;
let exitHooked = false;
let retryTimer = null;

const removeRecord = (file) => {
  try {
    rmSync(file, { force: true });
    leftover.delete(file);
  } catch {
    leftover.add(file);
  }
};
const retryLeftover = () => {
  for (const f of [...leftover]) removeRecord(f);
};

/** Writes the record (folder first). Synchronous so a timer cannot run between a release and its removal. */
const writeRecord = (rec) => {
  try {
    mkdirSync(path.dirname(rec.file), { recursive: true });
    writeFileSync(rec.file, rec.content);
    rec.written = true;
  } catch {
    /* tried again by the timer */
  }
};

/**
 * Writes a `.gate` record in dir and keeps it fresh until release(). Never throws on a write error:
 * written is the first attempt's result, and the timer keeps writing until it succeeds or the record is released.
 */
export function holdRecord(info, { dir, heartbeatMs = HEARTBEAT_MS } = {}) {
  if (!dir) throw new Error('holdRecord: dir is required');
  if (!exitHooked) {
    exitHooked = true;
    process.on('exit', () => {
      for (const f of [...held.keys(), ...leftover]) removeRecord(f); // what still remains is a free place after 5 minutes
    });
  }
  seq += 1;
  const file = path.join(dir, `${hostName()}~${process.pid}~${seq}.gate.json`);
  const content = `${JSON.stringify({ pid: process.pid, host: os.hostname(), ...info, startedAt: new Date().toISOString() })}\n`;
  const rec = { file, content, written: false, released: false, timer: null };
  retryLeftover();
  writeRecord(rec);
  const written = rec.written;
  held.set(file, rec);
  rec.timer = setInterval(() => {
    if (rec.released) return;
    retryLeftover();
    if (!rec.written) return writeRecord(rec);
    try {
      const t = new Date();
      utimesSync(file, t, t);
    } catch (err) {
      if (err.code === 'ENOENT') writeRecord(rec); // another process took it for stale and removed it
    }
  }, heartbeatMs);
  rec.timer.unref();
  const release = () => {
    if (rec.released) return;
    rec.released = true;
    clearInterval(rec.timer);
    held.delete(file);
    removeRecord(file);
    if (leftover.size && !retryTimer) {
      retryTimer = setInterval(() => {
        retryLeftover();
        if (!leftover.size) {
          clearInterval(retryTimer);
          retryTimer = null;
        }
      }, heartbeatMs);
      retryTimer.unref();
    }
  };
  return { file, release, written };
}

/** Live records in dir (recordHeld decides): [{ file, host, pid, gate }]. Removes nothing; the caller leaves out its own file. */
export function liveRecords(dir, { now = Date.now(), alive = pidAlive, myHost = hostName(), young = process.uptime() * 1000 < HEARTBEAT_MS + 15000, staleMs = STALE_MS } = {}) {
  if (!dir) throw new Error('liveRecords: dir is required');
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    const m = RECORD_NAME.exec(name);
    if (!m) continue;
    const file = path.join(dir, name);
    if (leftover.has(file)) continue; // released by this process but not removed
    let mtimeMs;
    try {
      mtimeMs = statSync(file).mtimeMs;
    } catch {
      continue; // released meanwhile
    }
    const pid = Number(m[2]);
    if (recordHeld({ host: m[1], pid, mtimeMs }, { now, myHost, alive, young, staleMs })) out.push({ file, host: m[1], pid, gate: Boolean(m[3]) });
  }
  return out;
}
