// Fake Codex app-server daemon for tests/codex-opinion.test.mjs. Answers the JSON-RPC requests
// the --peer mode of codex-opinion.mjs sends, from a scenario; used in memory by the tests and
// behind the WebSocket of `fake-codex.mjs app-server proxy`, so both paths see the same answers.
// Scenario (plain JSON, so the fake proxy can read it from a file):
//   threads:  [{ id, cwd, status ('idle' | { type, activeFlags }), threadSource, ephemeral, parentThreadId,
//               createdAt, turns: [{ id, status, items: [{ type, text | content, phase }] }] }]
//   loaded:   ids thread/loaded/list gives (default: every thread)
//   pageSize: entries per page of every list (default 50)
//   initialize: 'ok' (default) | 'error' | 'silent'
//   onStart:  { kind, reads, answer } - what turn/start does: kind 'answer' (default; a new turn that
//             completes with `answer` after `reads` turn lists), 'oldTurn' (gives the newest existing
//             turn's id), 'mixed' (another user message joins the new turn), 'interrupted', 'never'
//             (stays in progress), 'nextTurn' (another turn starts as ours completes), 'waiting'
//             (waits on approval first), 'error' (the request fails)
// Requests the daemon itself sends (an approval request after initialize) expect no answer.

const statusOf = (s) => (typeof s === 'string' ? { type: s } : s);

export function createDaemon(scenario = {}, { onLog = () => {} } = {}) {
  const pageSize = scenario.pageSize ?? 50;
  const onStart = { kind: 'answer', reads: 1, answer: 'Choice 1: A\nWhy: fake peer.\nRisk: none', ...(scenario.onStart || {}) };
  const threads = new Map();
  for (const t of scenario.threads || []) {
    threads.set(t.id, {
      ...t,
      status: statusOf(t.status ?? 'idle'),
      turns: (t.turns || []).map((turn) => ({ ...turn, items: (turn.items || []).map((i) => ({ ...i, turnId: turn.id })) })),
    });
  }
  const log = [];
  let turnCount = 0;
  let running = null; // { thread, turn, reads }

  const page = (all, params) => {
    const from = params.cursor ? Number(params.cursor) : 0;
    const data = all.slice(from, from + pageSize);
    return { data, nextCursor: from + pageSize < all.length ? String(from + pageSize) : null };
  };
  const ordered = (list, params) => (params.sortDirection === 'desc' ? [...list].reverse() : list);
  const threadOf = (params) => {
    const t = threads.get(params.threadId);
    if (!t) throw new Error(`thread not found: ${params.threadId}`);
    return t;
  };
  const publicThread = (t) => {
    const { turns, ...rest } = t;
    return rest;
  };
  const newTurn = (t, text, extra = []) => {
    const id = `turn-new-${++turnCount}`;
    const turn = { id, status: 'inProgress', items: [{ type: 'userMessage', turnId: id, content: [{ type: 'text', text }] }, ...extra.map((i) => ({ ...i, turnId: id }))] };
    t.turns.push(turn);
    return turn;
  };
  const finish = () => {
    const { thread: t, turn } = running;
    running = null;
    const end = onStart.kind === 'interrupted' ? 'interrupted' : 'completed';
    turn.status = end;
    if (end === 'completed') {
      turn.items.push({ type: 'agentMessage', turnId: turn.id, phase: 'commentary', text: 'Reading the brief.' });
      turn.items.push({ type: 'agentMessage', turnId: turn.id, phase: 'final_answer', text: onStart.answer });
    }
    t.status = { type: 'idle' };
    if (onStart.kind === 'nextTurn') {
      newTurn(t, 'the user asks something else');
      t.status = { type: 'active', activeFlags: [] };
    }
  };

  const methods = {
    initialize: () => {
      if (scenario.initialize === 'error') throw new Error('not initialized');
      if (scenario.initialize === 'silent') return undefined;
      return { userAgent: 'fake-codex/0.160.0' };
    },
    'thread/loaded/list': (params) => page(scenario.loaded ?? [...threads.keys()], params),
    'thread/read': (params) => ({ thread: publicThread(threadOf(params)) }),
    'thread/turns/list': (params) => {
      const t = threadOf(params);
      if (running && running.thread === t && onStart.kind !== 'never' && ++running.reads >= onStart.reads) finish();
      return page(ordered(t.turns.map(({ id, status }) => ({ id, status })), params), params);
    },
    'thread/items/list': (params) => page(ordered(threadOf(params).turns.flatMap((turn) => turn.items), params), params),
    'turn/start': (params) => {
      const t = threadOf(params);
      const text = params.input?.[0]?.text ?? '';
      if (onStart.kind === 'error') throw new Error('turn/start refused');
      if (onStart.kind === 'oldTurn') {
        const last = t.turns.at(-1);
        last.items.push({ type: 'userMessage', turnId: last.id, content: [{ type: 'text', text }] });
        return { turn: { id: last.id, status: 'inProgress' } };
      }
      const extra = onStart.kind === 'mixed' ? [{ type: 'userMessage', content: [{ type: 'text', text: 'the user typed this too' }] }] : [];
      const turn = newTurn(t, text, extra);
      t.status = { type: 'active', activeFlags: onStart.kind === 'waiting' ? ['waitingOnApproval'] : [] };
      running = { thread: t, turn, reads: 0 };
      return { turn: { id: turn.id, status: 'inProgress' } };
    },
    'turn/interrupt': (params) => {
      const t = threadOf(params);
      const turn = t.turns.find((x) => x.id === params.turnId);
      if (turn) turn.status = 'interrupted';
      if (running && running.turn === turn) running = null;
      t.status = { type: 'idle' };
      return {};
    },
  };

  /** Handles one message from the client; `reply(text)` sends a message back. */
  function receive(text, reply) {
    const msg = JSON.parse(text);
    const entry = { method: msg.method, params: msg.params, id: msg.id };
    log.push(entry);
    onLog(entry);
    if (msg.id === undefined) return;
    const fn = methods[msg.method];
    if (!fn) {
      reply(JSON.stringify({ id: msg.id, error: { code: -32601, message: `unknown method ${msg.method}` } }));
      return;
    }
    let result;
    try {
      result = fn(msg.params || {});
    } catch (err) {
      reply(JSON.stringify({ id: msg.id, error: { code: -32600, message: err.message } }));
      return;
    }
    if (result === undefined) return;
    if (msg.method === 'initialize') {
      // The daemon talks first too: a notification and a request the script must leave unanswered.
      reply(JSON.stringify({ method: 'thread/started', params: { threadId: 'x' } }));
      reply(JSON.stringify({ id: 0, method: 'item/commandExecution/requestApproval', params: {} }));
    }
    reply(JSON.stringify({ id: msg.id, result }));
  }

  return { receive, log, threads };
}

/** A connect function for main() that talks to `daemon` in memory, one tick per message. */
export function memoryConnect(daemon, { fail = null } = {}) {
  const state = { closed: false, connects: 0 };
  const connect = async () => {
    state.connects++;
    if (fail) throw new Error(fail);
    let onMessage = () => {};
    return {
      send(text) {
        if (state.closed) return;
        setImmediate(() => daemon.receive(text, (reply) => setImmediate(() => !state.closed && onMessage(reply))));
      },
      onMessage(cb) {
        onMessage = cb;
      },
      onClose() {},
      async close() {
        state.closed = true;
      },
    };
  };
  return { connect, state };
}
