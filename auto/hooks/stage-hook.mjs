// Stage agent hook: the stage guard (stage-guard.mjs) first; an allowed shell command also passes the commit gate, whose deny wins.
// am-auto's hooks.json entry: its command imports this file and calls main(). Runs nothing on import.

export const STAGE_PREFIX = 'am-auto:stage-';

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

/** The hook's stdout for a stage agent's input; null when raw is not a stage agent's input (nothing is loaded then). */
export async function stageOutput(raw) {
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!payload || typeof payload.agent_type !== 'string' || !payload.agent_type.startsWith(STAGE_PREFIX)) return null;
  const event = payload.hook_event_name;
  try {
    const guard = await import('./stage-guard.mjs');
    const verdict = guard.decide(payload);
    if (event === 'SubagentStop' || !['Bash', 'PowerShell'].includes(payload.tool_name)) return verdict.stdout;
    const out = JSON.parse(verdict.stdout);
    if (out.hookSpecificOutput.permissionDecision !== 'allow') return verdict.stdout;
    const { decide } = await import('./gate.mjs');
    const gate = await decide(raw);
    if (!gate.stdout) return verdict.stdout;
    const g = JSON.parse(gate.stdout);
    if (g.hookSpecificOutput?.permissionDecision === 'deny') return gate.stdout;
    if (g.hookSpecificOutput?.additionalContext) out.hookSpecificOutput.additionalContext = g.hookSpecificOutput.additionalContext;
    if (g.systemMessage) out.systemMessage = g.systemMessage;
    return JSON.stringify(out) + '\n';
  } catch (err) {
    return refusal(payload, err && err.message);
  }
}

/** A stage agent is never let through unchecked: deny the tool call, or block the stop once. */
function refusal(payload, message) {
  const reason = `am stage hook: crashed (${message}), so this was refused; tell the user.`;
  if (payload && payload.hook_event_name === 'SubagentStop') return payload.stop_hook_active === true ? '' : JSON.stringify({ decision: 'block', reason }) + '\n';
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }) + '\n';
}

export async function main() {
  const stdout = await stageOutput(await readInput());
  if (typeof stdout === 'string' && stdout) process.stdout.write(stdout);
  process.exitCode = 0;
}
