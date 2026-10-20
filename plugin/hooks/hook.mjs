// Hook entry point of hooks.json: PreToolUse of the shell tools (Bash, PowerShell) and the file tools (Write, Edit,
// MultiEdit, NotebookEdit), and SubagentStop. hooks.json loads this file with `node -e "import(...)"`, so it runs on import.
// Before anything else it creates the missing user files (scripts/user-files.mjs).
// Input whose agent_type starts with am-auto:stage- (an am-auto:agent stage agent) ends with no output and loads nothing:
// am-auto's own hooks.json checks those. Any other input goes to the commit gate (gate.mjs), imported inside the try, so a
// load failure also ends with the crash notice and exit 0.

// No install-time hook exists, so the first hook call creates the two user files, with no hooks.json entry of its own.
// A load or creation failure is swallowed so it never changes the gate or the output.
try { (await import('../scripts/user-files.mjs')).ensureUserFiles(process.env); } catch {}

/** Reads all of stdin; gives up after 5 s so a hook without input cannot hang (as gate.mjs's readStdin). */
function readInput() {
  return new Promise((resolve) => {
    let data = '';
    const timer = setTimeout(() => {
      process.stdin.destroy();
      resolve(data);
    }, 5000);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => {
      data += c;
    });
    process.stdin.on('end', () => {
      clearTimeout(timer);
      resolve(data);
    });
    process.stdin.on('error', () => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

const raw = await readInput();
let stageAgent = false;
try {
  const p = JSON.parse(raw);
  stageAgent = Boolean(p && typeof p.agent_type === 'string' && p.agent_type.startsWith('am-auto:stage-'));
} catch {
  // Not JSON: the gate reports it.
}

if (stageAgent) {
  process.exitCode = 0;
} else {
  try {
    const { decide } = await import('./gate.mjs');
    const result = await decide(raw);
    if (result.stdout) process.stdout.write(result.stdout);
    process.exitCode = 0;
  } catch (err) {
    // A bug here must not stop every commit: warn and let the command through.
    const message = `am gate: hook crashed (${err && err.message}) - this commit was NOT checked; tell the user.`;
    process.stdout.write(JSON.stringify({ systemMessage: message, hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: message } }) + '\n');
    process.exitCode = 0;
  }
}
