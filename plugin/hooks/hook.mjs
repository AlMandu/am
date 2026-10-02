// PreToolUse entry point. hooks.json loads this file with `node -e "import(...)"`,
// so it runs on import; the decision logic lives in gate.mjs.
import { decide, readStdin } from './gate.mjs';

try {
  const result = await decide(await readStdin());
  if (result.stdout) process.stdout.write(result.stdout);
  process.exitCode = result.code;
} catch (err) {
  // A bug here must not stop every commit: warn and let the command through.
  const message = `am gate: hook crashed (${err && err.message}) - this commit was NOT checked; tell the user.`;
  process.stdout.write(JSON.stringify({ systemMessage: message, hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: message } }) + '\n');
  process.exitCode = 0;
}
