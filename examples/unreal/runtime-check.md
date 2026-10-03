# Runtime check (Unreal example)

Copy this section into the project's CLAUDE.md or AGENTS.md and adjust the commands.
The am:check skill reads it after the gate. The agent does each step it can;
only what it cannot do goes to the human checklist.

## Runtime check

1. The gate copies the project to `Saved/AmGate`, builds a DebugGame editor there and runs the
   automation tests against it. The open editor keeps running its own binaries, so a C++
   change shows there only after Live Coding (Ctrl+Alt+F11 on Windows), a build from the IDE
   or an editor restart. Tell the human which one the change needs.
2. Prefer a probe over eyeballing: an automation test that drives the action and checks the
   values the change should produce (for example `TestEqual(TEXT("damage"), Damage, 120)`).
   Run one group with `node DevTools/ue-gate.mjs test --filter MyGame.Combat`; the summary
   names each failed test and its first error.
3. Behaviour that needs a level: a latent automation test that loads the map, or a functional
   test map (Functional Testing plugin). Both run through the same test command.
4. Blueprint impact of a C++ change (renamed function, property or class):
   `node DevTools/ue-gate.mjs blueprints` compiles every Blueprint and lists the errors.
5. For a bug fix, repeat the reproduction recorded in the plan before reading the probe.

Logs: the gate writes `Saved/AmGate/Saved/Logs/am-gate-test.log` and `am-gate-blueprints.log`
under the project folder; a failure summary prints the path. The open editor's own log is
`Saved/Logs/<Project>.log` on Windows and
`~/Library/Logs/Unreal Engine/<Project>Editor/<Project>.log` on macOS.

Human checklist format (at most 5 items):
- where: level or screen, PIE or standalone, account state
- what to do: the exact clicks or keys
- what they should see: the visible result that means "pass"
