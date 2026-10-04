#!/usr/bin/env node
// 테스트용 가짜 claude. 모델 대신 프롬프트 모양을 보고, 각 단계가 남겨야 할 파일과 커밋을 만든다.
// 시나리오(FAKE_SCENARIO 가 가리키는 JSON)로 단계별 결과를 순서대로 지정할 수 있다:
//   { "plan": { "<slug>": ["NEEDS_DECISION", "READY"] }, "check": { "<slug>": ["BLOCK", "NOTE"] },
//     "implement": { "<slug>": ["CRASH", "DONE"] }, "breakGate": ["<slug>"], "split": ["<fixture>", ...] }
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
if (argv.includes('--version')) {
  process.stdout.write('2.1.290 (fake)\n');
  process.exit(0);
}
const flag = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : null);
const cwd = process.cwd();
const scenario = process.env.FAKE_SCENARIO ? JSON.parse(readFileSync(process.env.FAKE_SCENARIO, 'utf8')) : {};
const stateDir = path.join(cwd, '.orchestrator');
mkdirSync(stateDir, { recursive: true });
const counterFile = path.join(stateDir, 'fake-counters.json');
const counters = existsSync(counterFile) ? JSON.parse(readFileSync(counterFile, 'utf8')) : {};
const nth = (key) => {
  counters[key] = (counters[key] || 0) + 1;
  writeFileSync(counterFile, JSON.stringify(counters));
  return counters[key];
};
/** 시나리오에 적힌 결과를 호출 순서대로 꺼낸다. 다 쓰면 마지막 값을 계속 쓴다. */
const pick = (kind, key, fallback) => {
  const list = kind === 'split' ? scenario.split : scenario[kind]?.[key];
  if (!list) return fallback;
  return list[Math.min(nth(`${kind}:${key}`), list.length) - 1];
};
const write = (file, text) => {
  mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
  writeFileSync(path.join(cwd, file), text);
};
const gitc = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' });
/** 세션이 게이트(빌드)를 돌리는 상황: 저장소의 gate-check.js 를 실행한다. 실패해도 넘어간다. */
const runBuild = () => {
  try {
    execFileSync(process.execPath, ['gate-check.js'], { cwd, stdio: 'ignore' });
  } catch {
    /* 게이트 실패는 여기서 중요하지 않다 */
  }
};

let prompt = flag('-p') || '';
const session = flag('--resume') || randomUUID();
appendFileSync(path.join(stateDir, 'fake-calls.jsonl'), `${JSON.stringify({ prompt, argv })}\n`);

if (flag('--output-format') === 'stream-json') {
  // doctor 의 시험 호출: 세션 시작 정보(init)와 답(result)을 한 줄씩 낸다
  const root = process.env.FAKE_PLUGIN_ROOT || '';
  const amLoaded = !process.env.FAKE_AM_NOT_INSTALLED || argv.includes('--plugin-dir'); // 설치돼 있지 않으면 --plugin-dir 을 줘야 실린다
  const commands = process.env.FAKE_NO_SLASH || !amLoaded ? ['help'] : ['am:plan', 'am:check', 'am:commit', ...(existsSync(path.join(root, 'skills', 'do', 'SKILL.md')) ? ['am:do'] : [])];
  const init = { type: 'system', subtype: 'init', session_id: session, slash_commands: commands, plugins: amLoaded ? [{ name: 'am', path: flag('--plugin-dir') || root }] : [] };
  const result = process.env.FAKE_NOT_LOGGED_IN ? { type: 'result', subtype: 'success', is_error: true, result: 'Not logged in · Please run /login', session_id: session } : { type: 'result', subtype: 'success', is_error: false, result: 'OK', session_id: session };
  process.stdout.write(`${JSON.stringify(init)}\n${JSON.stringify(result)}\n`);
  process.exit(result.is_error ? 1 : 0);
}

// inline 방식: 채워진 SKILL.md 를 읽어 같은 뜻의 슬래시 호출로 바꾼다
let m = /^Follow the instructions in (\S+) exactly/.exec(prompt);
if (m) {
  const body = readFileSync(path.join(cwd, m[1]), 'utf8');
  const skill = /skill-(\w+)\.md$/.exec(m[1])[1];
  const args = /^(?:Request|Target|Notes|Plan): (.*)$/m.exec(body)[1];
  if (body.includes('$ARGUMENTS') || body.includes('${CLAUDE_PLUGIN_ROOT}') || body.startsWith('---')) throw new Error('skill file was not expanded');
  prompt = `/am:${skill} ${args}`.trim();
}

let text = 'OK';
let denials = [];
if ((m = /^Split the design document (\S+) into tasks and write (\S+)\.$/.exec(prompt))) {
  copyFileSync(pick('split', 'x', process.env.FAKE_TASKS), path.join(cwd, m[2]));
  text = 'Wrote the task list.\nORCH_STATUS: DONE';
} else if ((m = /^tasks\.json failed validation\. Read \S+, fix (\S+), and stop/.exec(prompt))) {
  copyFileSync(pick('split', 'x', process.env.FAKE_TASKS), path.join(cwd, m[1]));
  text = 'Fixed.\nORCH_STATUS: DONE';
} else if ((m = /^\/am:plan Plan task (\S+) described in (\S+) \(slug ([a-z0-9-]+)\)$/.exec(prompt))) {
  const slug = m[3];
  if (!existsSync(path.join(cwd, m[2]))) throw new Error('brief missing');
  const outcome = pick('plan', slug, 'READY');
  if (outcome === 'TOO_BIG') {
    write(`.am/${slug}/split.json`, JSON.stringify({ reason: 'too many files', tasks: [
      { key: 'core', title: `${slug} core`, goal: 'core part', files: ['src/**'], acceptance: ['gate passes'], dependsOn: [], size: 'S' },
      { key: 'ui', title: `${slug} ui`, goal: 'ui part', files: ['src/**'], acceptance: ['gate passes'], dependsOn: ['core'], size: 'S' },
    ] }));
  } else if (outcome === 'NOSAVE') {
    // 계획은 세웠지만 Write 와 Bash 가 권한 규칙에 걸려 파일로 남기지 못한 상황
    denials = [{ tool_name: 'Write', tool_input: { file_path: `/elsewhere/${slug}/plan.md` } }, { tool_name: 'Bash', tool_input: { command: `cat > .am/${slug}/plan.md <<EOF` } }];
  } else if (outcome === 'STRAY') {
    write('stray.txt', 'plan phase must not do this\n');
    write(`.am/${slug}/plan.md`, '# plan\n');
  } else write(`.am/${slug}/plan.md`, `# ${slug}\n## Decisions\n${outcome === 'NEEDS_DECISION' ? 'OPEN: which screen first?\n' : 'Defaults applied: none\n'}${(scenario.autoDecide || []).includes(slug) ? '- 첫 화면은 목록으로 한다 - 지금 화면과 가장 비슷함 (자동 결정)\n' : ''}## Steps\n1. write the file. Check: gate\n`);
  if (outcome === 'NOSAVE') text = `# ${slug}\n(plan body that could not be saved)\nORCH_STATUS: NEEDS_DECISION`;
  else text = `${outcome === 'NEEDS_DECISION' ? 'Decision card: which screen first? 1) list 2) detail\n' : ''}ORCH_STATUS: ${outcome === 'STRAY' ? 'READY' : outcome}`;
} else if ((m = /^The plan was not saved: \.am\/([a-z0-9-]+)\/plan\.md does not exist/.exec(prompt))) {
  if (!flag('--resume')) throw new Error('plan save retry must resume the plan session');
  if (scenario.planSave === 'FAIL') {
    denials = [{ tool_name: 'Write', tool_input: { file_path: `/elsewhere/${m[1]}/plan.md` } }];
    text = 'Still refused.\nORCH_STATUS: NEEDS_DECISION';
  } else {
    write(`.am/${m[1]}/plan.md`, `# ${m[1]}\n## Steps\n1. write the file. Check: gate\n`);
    text = 'Saved.\nORCH_STATUS: READY';
  }
} else if ((m = /^The user answered the open decisions in \.am\/([a-z0-9-]+)\/answers\.md/.exec(prompt))) {
  const answers = readFileSync(path.join(cwd, `.am/${m[1]}/answers.md`), 'utf8');
  appendFileSync(path.join(cwd, `.am/${m[1]}/plan.md`), `## Decisions (answered)\n${answers}\n`);
  text = 'Recorded.\nORCH_STATUS: READY';
} else if ((m = /^\/am:(?:do|plan) ([a-z0-9-]+)$/.exec(prompt))) {
  const slug = m[1];
  const outcome = pick('implement', slug, 'DONE');
  if (scenario.snapshotReport) {
    // 세션이 도는 동안의 보고서를 남겨, 진행 중 표시를 확인할 수 있게 한다
    const runs = path.join(stateDir, 'runs', readFileSync(path.join(stateDir, 'current'), 'utf8').trim());
    copyFileSync(path.join(runs, 'report.md'), path.join(stateDir, 'report-during-implement.md'));
  }
  if (outcome === 'SLOW') {
    writeFileSync(path.join(stateDir, 'fake-slow.pid'), String(process.pid));
    await new Promise((resolve) => setTimeout(resolve, 60000)); // 오래 걸리는 세션
  }
  if (outcome === 'CRASH') {
    write(`src/${slug}.txt`, 'half done\n');
    process.stderr.write('usage limit reached\n');
    process.exit(1);
  }
  if (outcome === 'BLOCKED') write(`src/${slug}.txt`, 'partial\n');
  if (outcome === 'DONE') {
    write(`src/${slug}.txt`, `implemented ${slug}\n`);
    if ((scenario.breakGate || []).includes(slug) && nth(`break:${slug}`) === 1) write('BROKEN', slug);
    if ((scenario.breakGateAlways || []).includes(slug)) write('BROKEN', slug);
    if ((scenario.breakSlow || []).includes(slug) && nth(`slow:${slug}`) === 1) write('SLOW_BROKEN', slug); // 느린(비차단) 검사만 깨뜨림
    for (const f of scenario.extraFiles || []) write(f, 'extra\n'); // 예상 파일 밖의 변경
    if ((scenario.editVolatile || []).includes(slug)) write('settings.asset', 'prefilter: 0\nshadows: on\n'); // 작업이 설정 파일을 실제로 고침
  }
  text = `ORCH_STATUS: ${outcome}`;
} else if ((m = /^\/am:check ([a-z0-9-]+)$/.exec(prompt))) {
  const slug = m[1];
  if (scenario.checkRunsGate) runBuild(); // am:check 가 세션 안에서 게이트를 돌림
  if (scenario.checkAddsIntent) gitc('add', '-N', '.'); // 새 파일이 diff 에 보이도록 점검 세션이 흔히 하는 일
  let verdict = pick('check', slug, 'NOTE');
  if (existsSync(path.join(cwd, 'BROKEN')) && verdict !== 'SILENT') verdict = 'BLOCK';
  const shown = verdict === 'SILENT' || verdict === 'FILEONLY' ? 'NOTE' : verdict;
  write(`.am/${slug}/check.md`, `판정: ${shown}\n게이트: ${shown === 'BLOCK' ? 'fail' : 'pass'}\n사람 확인: ${slug} 화면에서 버튼을 누르면 값이 보인다\n`);
  text = verdict === 'SILENT' || verdict === 'FILEONLY' ? 'checked.' : `ORCH_VERDICT: ${verdict}`;
  if (verdict === 'FILEONLY') writeFileSync(path.join(stateDir, 'fake-mute'), '1');
} else if ((m = /^am:check blocked this task\. Read \.am\/([a-z0-9-]+)\/check\.md and (\S+),/.exec(prompt))) {
  if (!flag('--resume')) throw new Error('fix must resume the implement session');
  if (!existsSync(path.join(cwd, m[2]))) throw new Error('gate.json missing');
  if (!(scenario.breakGateAlways || []).includes(m[1])) rmSync(path.join(cwd, 'BROKEN'), { force: true });
  rmSync(path.join(cwd, 'SLOW_BROKEN'), { force: true });
  appendFileSync(path.join(cwd, `src/${m[1]}.txt`), 'fixed\n');
  text = 'ORCH_STATUS: DONE';
} else if ((m = /^\/am:commit task (\S+) ([a-z0-9-]+)$/.exec(prompt))) {
  const outcome = pick('commit', m[2], 'COMMITTED');
  if (outcome === 'COMMITTED') {
    gitc('add', '-A');
    gitc('commit', '-q', '-m', `feat(${m[2]}): fake commit`);
  }
  if (outcome === 'RESTORE') {
    // 점검이 빌드 산출물이라고 적은 파일은 커밋하지 않고 되돌린 뒤, 나머지를 커밋한다
    gitc('restore', '--', 'settings.asset');
    gitc('add', '-A');
    gitc('commit', '-q', '-m', `feat(${m[2]}): fake commit`);
  }
  if (outcome === 'REJECT') gitc('add', '-A'); // 스테이징까지 했지만 저장소의 pre-commit 훅이 커밋을 거부함
  if (outcome === 'LEAVE') {
    gitc('add', 'src'); // 설정 파일은 "이 작업의 것이 아니다"라며 남겨 둠
    gitc('commit', '-q', '-m', `feat(${m[2]}): fake commit`);
  }
  if (scenario.commitRunsGate && outcome !== 'BLOCKED') runBuild(); // 커밋 게이트 훅의 빌드가 파일을 다시 씀
  if (outcome === 'DENIED') {
    gitc('add', '-A'); // 스테이징까지는 됐고 커밋 명령만 권한 규칙에 걸린 상황
    denials = [{ tool_name: 'Bash', tool_input: { command: 'git -C /somewhere commit -m "x" | tail -20' } }];
  }
  if (outcome === 'REJECT') text = 'The pre-commit hook rejected the commit:\nR1 MODULE.md must change together with src/ (no history line)\nORCH_STATUS: BLOCKED';
  else if (outcome === 'RESTORE') text = 'Left out build output.\nORCH_RESTORED: settings.asset\nORCH_STATUS: COMMITTED';
  else text = `ORCH_STATUS: ${outcome === 'DENIED' ? 'BLOCKED' : outcome === 'LEAVE' ? 'COMMITTED' : outcome}`;
} else if ((m = /^The commit for this task did not go through\. Read (\S+) for what the commit session reported/.exec(prompt))) {
  if (!flag('--resume')) throw new Error('the fix must resume the implement session');
  if (!readFileSync(path.join(cwd, m[1]), 'utf8').includes('R1 MODULE.md')) throw new Error('hook output was not handed over');
  if (scenario.rejectFix === 'BLOCKED') text = 'cannot fix\nORCH_STATUS: BLOCKED';
  else {
    appendFileSync(path.join(cwd, 'MODULE.md'), '- history: fixed after the hook rejected the commit\n');
    text = 'Added the history line.\nORCH_STATUS: DONE';
  }
} else if (/^Some of your commands were refused by the permission rules/.test(prompt)) {
  if (!flag('--resume')) throw new Error('commit retry must resume the commit session');
  const outcome = scenario.commitRetry || 'COMMITTED';
  if (outcome === 'COMMITTED') gitc('commit', '-q', '-m', 'feat: fake commit after retry');
  else denials = [{ tool_name: 'Bash', tool_input: { command: 'git -C /somewhere commit -m "x"' } }];
  text = `ORCH_STATUS: ${outcome === 'COMMITTED' ? 'COMMITTED' : 'BLOCKED'}`;
} else if ((m = /^Reply with exactly one line and nothing else: (\w+): (\w+)/.exec(prompt))) {
  text = existsSync(path.join(stateDir, 'fake-mute')) ? 'sorry' : `${m[1]}: ${m[2] === 'BLOCK' ? 'NOTE' : m[2]}`;
} else throw new Error(`fake claude: unknown prompt: ${prompt}`);

process.stdout.write(`${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: session, total_cost_usd: 0.01, num_turns: 3, permission_denials: denials })}\n`);
