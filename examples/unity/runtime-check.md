# Runtime check (Unity example)

Copy this section into the project's CLAUDE.md or AGENTS.md and adjust the commands.
The am:check skill reads it after the compile gate. The agent does each step it can;
only what it cannot do goes to the human checklist.

## Runtime check

1. Recompile in the editor and read the console. The MSBuild gate only compiles files
   already listed in the generated .csproj, so a new .cs file can pass the gate without
   being compiled. If the editor is open and a command-line bridge is installed (for
   example the `unity` CLI with the pipeline package), trigger a recompile and read the
   console errors. Otherwise ask the human to focus the editor and report console errors.
2. Enter Play mode from the scene the change affects. Capture the Game view before and
   after the action the change is about.
3. Prefer a probe over eyeballing: an editor script that drives the action and logs the
   values the change should produce (for example `[probe] damage=120 expected=120`).
   Read the probe output from the console or the log file.
4. For a bug fix, repeat the reproduction recorded in the plan before reading the probe.

Human checklist format (at most 5 items):
- where: scene or screen, account state
- what to do: the exact taps or keys
- what they should see: the visible result that means "pass"
