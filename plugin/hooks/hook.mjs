// PreToolUse entry point. hooks.json loads this file with `node -e "import(...)"`,
// so it runs on import; the decision logic lives in gate.mjs.
// Before the gate it creates the missing user files (scripts/user-files.mjs).
import { decide, readStdin } from './gate.mjs';

// No install-time hook exists, so the first shell command creates the two user files; hooks.json stays unchanged,
// so Codex needs no re-trust. A load or creation failure is swallowed so it never changes the gate or the output.
try { (await import('../scripts/user-files.mjs')).ensureUserFiles(process.env); } catch {}

try {
  const result = await decide(await readStdin());
  if (result.stdout) process.stdout.write(result.stdout);
  process.exitCode = 0;
} catch (err) {
  // A bug here must not stop every commit: warn and let the command through.
  const message = `am gate: hook crashed (${err && err.message}) - this commit was NOT checked; tell the user.`;
  process.stdout.write(JSON.stringify({ systemMessage: message, hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: message } }) + '\n');
  process.exitCode = 0;
}
