// am user files: creates the two per-PC user files with their defaults written as notes, only when a file is missing.
// Files: <CLAUDE_CONFIG_DIR or ~/.claude>/am/models.json (user-models.mjs) and am/settings.json (user-settings.mjs).
// Keys starting with `_` are notes that both readers drop, so a new file changes nothing until a person removes the `_`.
// BUILTIN_MODELS is written by scripts/models.mjs from models.json; do not edit its values by hand.
// When the format or keys of the user models or settings file change, change the templates in the same commit.
// A file is created atomically (a temp file in the same folder, then a hard link), and an existing file is never touched.
// Reads no environment variable itself (the caller passes env). Node only, no dependencies.

import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { CODEX_EFFORTS, OPINION_MODELS, USER_EFFORTS, userModelsFile } from './user-models.mjs';
import { userSettingsFile } from './user-settings.mjs';
import { DEFAULT_MIN_FREE_MEMORY_MB } from './memory-guard.mjs';

export const BUILTIN_MODELS = {
  plan: { model: 'opus', effort: 'high' },
  do: { model: 'opus', effort: 'medium' },
  check: { model: 'opus', effort: 'high' },
  compactmem: { model: 'opus', effort: 'medium' },
  commit: { model: 'opus', effort: 'medium' },
  compact: { model: 'opus', effort: 'medium' },
  run: { model: 'opus', effort: 'medium' },
  split: { model: 'opus', effort: 'high' },
  'second-opinion': { model: 'opus', effort: 'high' },
  'codex-opinion': { model: 'gpt-6.1-sol', effort: 'high' },
};

// Link errors that mean the file system has no hard links; only these fall back to a direct `wx` write.
const NO_LINK = ['ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EPERM', 'EXDEV', 'EISDIR'];

/** Text of a new user models file: every built-in value as a note key. builtin is a parameter for tests. */
export function modelsTemplate(builtin = BUILTIN_MODELS) {
  const noCodexModel = !builtin['codex-opinion']?.model;
  const about = [
    'Keys starting with "_" are notes and are not used. Remove the "_" from a key to use its value.',
    'Changing a value but keeping the "_" changes nothing.',
    'The values below were the defaults when this file was created; the current defaults are in the model and effort table of the am README.',
    'The "default" key sets every stage session you do not name (not the second-opinion and codex-opinion keys).',
    'A model is an alias (opus, sonnet, ...) or a full model ID.',
    `An effort is one of ${USER_EFFORTS.join(', ')}.`,
    `The second-opinion model is one of ${OPINION_MODELS.join(', ')}; the codex-opinion effort is one of ${CODEX_EFFORTS.join(', ')}.`,
  ];
  if (noCodexModel) about.push("Without a codex-opinion model, Codex uses the user's own codex config.");
  const notes = (part) => Object.fromEntries(Object.entries(builtin).filter(([, v]) => v[part]).map(([key, v]) => [`_${key}`, v[part]]));
  return `${JSON.stringify({ _about: about, model: notes('model'), effort: notes('effort') }, null, 2)}\n`;
}

/** Text of a new user settings file: the built-in memory rule, with a note on every value. */
export function settingsTemplate() {
  const data = {
    _about: ['This file holds settings for every am run on this PC.', 'Keys starting with "_" are notes and are not used.'],
    minFreeMemoryMB: null,
    _minFreeMemoryMB: [
      'Free memory in MB that a new session waits for while other sessions run.',
      `null is the default: ${DEFAULT_MIN_FREE_MEMORY_MB} on Windows, off on macOS and Linux.`,
      '0 turns the wait off; a number applies on every OS, for example 6144.',
    ],
  };
  return `${JSON.stringify(data, null, 2)}\n`;
}

// Writes text to a new file (fails when it exists) and flushes it to disk, so a power cut leaves no empty file.
function writeNew(file, text) {
  const fd = openSync(file, 'wx');
  try {
    writeFileSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

// Creates file with text unless it exists. True when this call created it; never throws.
function create(file, text, { link, rm }) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    writeNew(tmp, text);
    try {
      link(tmp, file);
      return true;
    } catch (err) {
      if (!NO_LINK.includes(err && err.code)) return false; // EEXIST: another session made it; other errors: try next time
    }
    let fd;
    try {
      fd = openSync(file, 'wx');
    } catch {
      return false; // exists now or cannot be made: nothing of ours to remove
    }
    try {
      writeFileSync(fd, text);
      fsyncSync(fd);
      closeSync(fd);
      return true;
    } catch {
      try {
        closeSync(fd);
      } catch {}
      try {
        rm(file, { force: true });
      } catch {}
      return false;
    }
  } catch {
    return false;
  } finally {
    try {
      rm(tmp, { force: true });
    } catch {}
  }
}

/**
 * Creates the user models and settings files that are missing and returns their paths. Does nothing when the config
 * folder does not exist. Never throws and prints nothing. The second argument replaces linkSync and rmSync in tests.
 */
export function ensureUserFiles(env, { link = linkSync, rm = rmSync } = {}) {
  let files;
  try {
    files = [
      [userModelsFile(env), modelsTemplate],
      [userSettingsFile(env), settingsTemplate],
    ];
  } catch {
    return []; // no env, or no home folder to resolve
  }
  if (files.every(([file]) => existsSync(file))) return [];
  const amDir = path.dirname(files[0][0]);
  try {
    if (!statSync(path.dirname(amDir)).isDirectory()) return [];
    mkdirSync(amDir, { recursive: true });
  } catch {
    return [];
  }
  const created = [];
  for (const [file, template] of files) {
    if (existsSync(file)) continue;
    try {
      if (create(file, template(), { link, rm })) created.push(file);
    } catch {}
  }
  return created;
}
