// am commit gate example for Unreal Engine 5: build the editor target, run automation tests,
// compile every Blueprint. Node only, no dependencies. Checked on macOS (UE 5.8); the Windows
// paths follow the engine source but are untested; Linux is untested.
//
//   node DevTools/ue-gate.mjs build|test|blueprints|info [--project <file.uproject>]
//                             [--filter <test prefix>] [--config DebugGame|Development]
//
// Run it from the repository root (the gate does). Without --project it uses the only .uproject
// at the root or one folder below. The test filter defaults to the project name.
//
// Why a copy: every mode first syncs the .uproject, Source, Config, Content and Plugins into
// <project>/Saved/AmGate and works there. An editor left open on the project hot-reloads any new
// module file that appears in the project's Binaries folder (measured on macOS), and a headless
// editor run rewrites tracked Config files. The copy keeps both away from the project. It is not
// under Intermediate because UBT treats the first "Intermediate" in a path as its own folder, and
// it carries its own .gitignore. Files are cloned where the file system supports it (APFS),
// otherwise copied; only changed files are copied again. Delete Saved/AmGate to start over.
// Why DebugGame: the copy gets its own UnrealEditor-<Platform>-DebugGame binaries, so the build
// never collides with the editor's Development binaries or its Live Coding session on Windows.
// The first build compiles the whole project once.
//
// Engine lookup: UE_ROOT, then the .uproject EngineAssociation (launcher install list, then the
// Windows registry or Install.ini for source builds).
// Exit codes: 0 pass, 1 fail, 2 setup problem. Never 127/9009: the gate treats those as
// "command not found" and only warns.

import { spawn, execFileSync } from 'node:child_process';
import { constants, copyFileSync, existsSync, readFileSync, readdirSync, mkdirSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WIN = process.platform === 'win32';
const PLATFORM = WIN ? 'Win64' : process.platform === 'darwin' ? 'Mac' : 'Linux';
const CASE_SENSITIVE = PLATFORM === 'Linux';
const MAX_ERROR_LINES = 12;

class SetupError extends Error {}

function parseArgs(argv) {
  const opts = { mode: argv[0], project: null, filter: null, config: 'DebugGame' };
  for (let i = 1; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, '');
    if (!['project', 'filter', 'config'].includes(key) || argv[i + 1] === undefined) throw new SetupError(`unknown or empty option: ${argv[i]}`);
    opts[key] = argv[i + 1];
  }
  if (!['build', 'test', 'blueprints', 'info'].includes(opts.mode)) throw new SetupError('usage: node ue-gate.mjs build|test|blueprints|info [--project <file.uproject>] [--filter <prefix>] [--config DebugGame|Development]');
  return opts;
}

function findProject(explicit) {
  if (explicit) {
    const file = path.resolve(explicit);
    if (!existsSync(file)) throw new SetupError(`not found: ${file}`);
    return file;
  }
  const root = process.cwd();
  const found = [];
  for (const dir of [root, ...readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => path.join(root, d.name))]) {
    for (const f of readdirSync(dir)) if (f.endsWith('.uproject')) found.push(path.join(dir, f));
  }
  if (found.length !== 1) throw new SetupError(`${found.length === 0 ? 'no' : 'more than one'} .uproject at the root or one folder below; pass --project <file.uproject>`);
  return found[0];
}

const isEngine = (dir) => existsSync(path.join(dir, 'Engine', 'Build', 'Build.version'));
const readText = (file) => (existsSync(file) ? readFileSync(file, 'utf8').replace(/^\uFEFF/, '') : null);

function launcherList() {
  const file = WIN
    ? path.join(process.env.ProgramData || 'C:\\ProgramData', 'Epic', 'UnrealEngineLauncher', 'LauncherInstalled.dat')
    : path.join(os.homedir(), 'Library', 'Application Support', 'Epic', 'UnrealEngineLauncher', 'LauncherInstalled.dat');
  try {
    return JSON.parse(readText(file) || '{}').InstallationList || [];
  } catch {
    return [];
  }
}

function regValue(key, name) {
  try {
    const out = execFileSync('reg', ['query', key, '/v', name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    const m = /REG_SZ\s+(.+?)\s*$/m.exec(out);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

function iniValue(file, key) {
  const text = readText(file);
  const m = text && new RegExp(`^${key.replace(/[{}]/g, '\\$&')}=(.+?)\\s*$`, 'mi').exec(text);
  return m ? m[1] : null;
}

function findEngine(uproject) {
  const fromEnv = process.env.UE_ROOT;
  if (fromEnv) {
    for (const dir of [fromEnv, path.dirname(fromEnv)]) if (isEngine(dir)) return dir;
    throw new SetupError(`UE_ROOT is not an engine folder (no Engine/Build/Build.version): ${fromEnv}`);
  }
  const assoc = JSON.parse(readText(uproject)).EngineAssociation || '';
  const candidates = [];
  if (assoc === '') {
    for (let d = path.dirname(uproject); d !== path.dirname(d); d = path.dirname(d)) candidates.push(d);
  } else if (/^\d+\.\d+$/.test(assoc)) {
    candidates.push(...launcherList().filter((i) => i.AppName === `UE_${assoc}`).map((i) => i.InstallLocation));
    if (WIN) candidates.push(regValue(`HKLM\\SOFTWARE\\EpicGames\\Unreal Engine\\${assoc}`, 'InstalledDirectory'));
  } else if (WIN) {
    candidates.push(regValue('HKCU\\SOFTWARE\\Epic Games\\Unreal Engine\\Builds', assoc));
  } else {
    const base = process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support', 'Epic') : path.join(os.homedir(), '.config', 'Epic');
    candidates.push(iniValue(path.join(base, 'UnrealEngine', 'Install.ini'), assoc));
  }
  const engine = candidates.find((c) => c && isEngine(c));
  if (!engine) throw new SetupError(`engine "${assoc || '(none)'}" from ${path.basename(uproject)} not found; set UE_ROOT to the engine folder`);
  return engine;
}

/** Editor target from Source/*.Target.cs; null for a Blueprint-only project. */
function editorTarget(projectDir, projectName) {
  const source = path.join(projectDir, 'Source');
  const targets = existsSync(source) ? readdirSync(source).filter((f) => f.endsWith('.Target.cs')) : [];
  if (targets.length === 0) return null;
  const editors = targets.filter((f) => /TargetType\.Editor\b/.test(readText(path.join(source, f)))).map((f) => f.replace(/\.Target\.cs$/, ''));
  if (editors.length === 0) throw new SetupError(`no editor target (TargetType.Editor) in ${source}`);
  return editors.includes(`${projectName}Editor`) ? `${projectName}Editor` : editors[0];
}

const MIRROR_DIRS = ['Source', 'Config', 'Content', 'Plugins'];

function syncFile(src, dst, st) {
  let old = null;
  try {
    old = statSync(dst);
  } catch {
    // not copied yet
  }
  if (old && old.size === st.size && Math.abs(old.mtimeMs - st.mtimeMs) < 1) return;
  // A read-only source (for example a git-lfs lockable asset) gives a read-only copy that cannot
  // be overwritten; remove the old copy first.
  if (old) unlinkSync(dst);
  copyFileSync(src, dst, constants.COPYFILE_FICLONE);
  utimesSync(dst, st.atimeMs / 1000, st.mtimeMs / 1000);
}

/**
 * Makes dst a copy of src. Deletes only entries under dst (never follows links, never writes to
 * src). A plugin's own Intermediate, and its Binaries when it has Source and the project builds
 * code, belong to the copy. Links are skipped and reported.
 */
function syncTree(src, dst, buildsCode) {
  const names = readdirSync(src);
  const isPlugin = names.some((n) => n.endsWith('.uplugin'));
  const owned = (n) => isPlugin && (n === 'Intermediate' || (buildsCode && n === 'Binaries' && names.includes('Source')));
  mkdirSync(dst, { recursive: true });
  // macOS and Windows ignore case: a case-only rename must replace the old entry, not reuse it.
  const existing = new Map(CASE_SENSITIVE ? [] : readdirSync(dst).map((n) => [n.toLowerCase(), n]));
  const keep = new Set();
  for (const e of readdirSync(src, { withFileTypes: true })) {
    if (owned(e.name)) continue;
    const s = path.join(src, e.name);
    if (!(e.isDirectory() || e.isFile())) {
      console.log(`[ue-gate] not copied (link or special file): ${s}`);
      continue;
    }
    keep.add(e.name);
    const old = existing.get(e.name.toLowerCase());
    if (old && old !== e.name) rmSync(path.join(dst, old), { recursive: true, force: true });
    const d = path.join(dst, e.name);
    if (e.isDirectory()) syncTree(s, d, buildsCode);
    else syncFile(s, d, statSync(s));
  }
  for (const n of readdirSync(dst)) if (!keep.has(n) && !owned(n)) rmSync(path.join(dst, n), { recursive: true, force: true });
}

/** Syncs the project into <project>/Saved/AmGate and returns the copy's .uproject. */
function syncMirror(uproject, buildsCode) {
  const projectDir = path.dirname(uproject);
  const mirror = path.join(projectDir, 'Saved', 'AmGate');
  mkdirSync(mirror, { recursive: true });
  if (!existsSync(path.join(mirror, '.gitignore'))) writeFileSync(path.join(mirror, '.gitignore'), '*\n');
  syncFile(uproject, path.join(mirror, path.basename(uproject)), statSync(uproject));
  for (const dir of MIRROR_DIRS) {
    const src = path.join(projectDir, dir);
    if (existsSync(src)) syncTree(src, path.join(mirror, dir), buildsCode);
    else rmSync(path.join(mirror, dir), { recursive: true, force: true });
  }
  return path.join(mirror, path.basename(uproject));
}

/** Windows runs .bat files only through cmd.exe, so quote each argument for it. */
function winArg(a) {
  if (!/[\s"&|<>^()]/.test(a)) return a;
  const m = /^(-[\w.]+=)(.*)$/.exec(a);
  return m ? `${m[1]}"${m[2]}"` : `"${a}"`;
}

/** Runs a tool and resolves {code, output}; output is kept in memory (capped). */
function run(file, args) {
  return new Promise((resolve) => {
    const child = WIN
      ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${[file, ...args].map(winArg).join(' ')}"`], { windowsVerbatimArguments: true, windowsHide: true })
      : spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const keep = (d) => {
      output = (output + d).slice(-2 * 1024 * 1024);
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    child.on('error', (err) => resolve({ code: 1, output: `${output}\n${err.message}` }));
    child.on('close', (code, signal) => resolve({ code: code ?? 1, output: signal ? `${output}\nkilled by ${signal}` : output }));
  });
}

function errorLines(text, pattern) {
  const lines = [...new Set(text.split(/\r?\n/).filter((l) => pattern.test(l)).map((l) => l.replace(/^\[[^\]]*\]\[[^\]]*\]/, '').trim()))];
  return lines.slice(-MAX_ERROR_LINES);
}

function editorCmd(engine, config) {
  const name = config === 'Development' ? 'UnrealEditor-Cmd' : `UnrealEditor-${PLATFORM}-${config}-Cmd`;
  const exe = path.join(engine, 'Engine', 'Binaries', PLATFORM, name + (WIN ? '.exe' : ''));
  if (!existsSync(exe)) throw new SetupError(`not found: ${exe} (try --config Development)`);
  return exe;
}

async function build(ctx) {
  if (!ctx.target) {
    console.log('[ue-gate] Blueprint-only project: no C++ to build');
    return 0;
  }
  const script = WIN ? path.join(ctx.engine, 'Engine', 'Build', 'BatchFiles', 'Build.bat') : path.join(ctx.engine, 'Engine', 'Build', 'BatchFiles', PLATFORM, 'Build.sh');
  const res = await run(script, [ctx.target, PLATFORM, ctx.config, `-Project=${ctx.uproject}`, '-WaitMutex', '-NoHotReloadFromIDE']);
  const result = errorLines(res.output, /^Result: /)[0] || `exit ${res.code}`;
  if (res.code === 0) {
    console.log(`[ue-gate] build ${ctx.target} ${PLATFORM} ${ctx.config}: ${result}`);
    return 0;
  }
  // Report source paths in the project, not in the copy.
  const output = res.output.split(ctx.projectDir + path.sep).join(ctx.realDir + path.sep);
  console.log(output.trimEnd().split(/\r?\n/).slice(-15).join('\n'));
  console.log(`[ue-gate] build ${ctx.target} ${PLATFORM} ${ctx.config} failed: ${result}`);
  for (const l of errorLines(output, /\berror\b|: fatal/i)) console.log(`  ${l}`);
  return 1;
}

/** Runs the editor headless with its log in Saved/Logs; returns {code, log, output, logFile}. */
async function runEditor(ctx, name, extraArgs, reportDir) {
  const logFile = path.join(ctx.projectDir, 'Saved', 'Logs', `am-gate-${name}.log`);
  mkdirSync(path.dirname(logFile), { recursive: true });
  rmSync(logFile, { force: true });
  const args = [ctx.uproject, ...extraArgs, '-unattended', '-nullrhi', '-nosplash', '-nosound', `-abslog=${logFile}`];
  if (reportDir) args.push(`-ReportExportPath=${reportDir}`);
  const res = await run(editorCmd(ctx.engine, ctx.config), args);
  return { ...res, log: readText(logFile) || '', logFile };
}

async function test(ctx) {
  const filter = ctx.filter || ctx.projectName;
  const reportDir = path.join(ctx.projectDir, 'Saved', 'Automation', `am-gate-${process.pid}`);
  rmSync(reportDir, { recursive: true, force: true });
  const res = await runEditor(ctx, 'test', [`-ExecCmds=Automation RunTests ${filter}; Quit`], reportDir);
  let report = null;
  try {
    report = JSON.parse(readText(path.join(reportDir, 'index.json')));
  } catch {
    // no report: the editor failed before the tests ran
  }
  rmSync(reportDir, { recursive: true, force: true });
  const tests = (report && report.tests) || [];
  // Skipped means excluded by the project's test exclude list; the engine does not count it.
  const skipped = tests.filter((t) => t.state === 'Skipped').length;
  const failed = tests.filter((t) => t.state !== 'Success' && t.state !== 'Skipped');
  const ok = res.code === 0 && report !== null && failed.length === 0;
  console.log(`[ue-gate] tests "${filter}" (${ctx.config}): ${tests.length - failed.length - skipped} passed, ${failed.length} failed${skipped ? `, ${skipped} skipped` : ''}${report ? '' : ', no report'}, exit ${res.code}`);
  for (const t of failed) {
    const first = (t.entries || []).find((e) => e.event && e.event.type === 'Error');
    const where = first && first.lineNumber > 0 ? ` (${path.basename(first.filename)}:${first.lineNumber})` : '';
    console.log(`  ${t.state.toUpperCase()} ${t.fullTestPath}: ${first ? first.event.message : 'no error message'}${where}`);
  }
  if (!ok && failed.length === 0) {
    for (const l of errorLines(res.log || res.output, /: Error: |Error: |error:/)) console.log(`  ${l}`);
  }
  if (!ok) console.log(`[ue-gate] full log: ${res.logFile}`);
  return ok ? 0 : 1;
}

async function blueprints(ctx) {
  const res = await runEditor(ctx, 'blueprints', ['-run=CompileAllBlueprints']);
  const summary = errorLines(res.log, /Compiling Completed with/)[0] || 'no summary line';
  console.log(`[ue-gate] blueprints (${ctx.config}): ${summary}, exit ${res.code}`);
  if (res.code === 0) return 0;
  for (const l of errorLines(res.log || res.output, /: Error: /)) console.log(`  ${l}`);
  console.log(`[ue-gate] full log: ${res.logFile}`);
  return 1;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const uproject = findProject(opts.project);
  const projectDir = path.dirname(uproject);
  const projectName = path.basename(uproject, '.uproject');
  const target = editorTarget(projectDir, projectName);
  const engine = findEngine(uproject);
  const config = target ? opts.config : 'Development';
  if (opts.mode === 'info') {
    console.log(`project: ${uproject}\ncopy:    ${path.join(projectDir, 'Saved', 'AmGate')}\nengine:  ${engine}\ntarget:  ${target || '(Blueprint-only)'} ${PLATFORM} ${config}\neditor:  ${editorCmd(engine, config)}`);
    return 0;
  }
  const started = Date.now();
  const copy = syncMirror(uproject, target !== null);
  const ctx = { ...opts, uproject: copy, projectDir: path.dirname(copy), realDir: projectDir, projectName, target, engine, config };
  const code = await { build, test, blueprints }[opts.mode](ctx);
  console.log(`[ue-gate] ${opts.mode}: ${code === 0 ? 'ok' : 'FAILED'} in ${((Date.now() - started) / 1000).toFixed(0)}s`);
  return code;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    console.log(`[ue-gate] ${err instanceof SetupError ? err.message : err.stack}`);
    process.exitCode = 2;
  },
);
