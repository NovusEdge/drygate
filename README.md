# drygate

drygate keeps coding agents from adding duplicated code. It has three parts:

- **A stop check.** When the agent finishes a turn, drygate runs [jscpd](https://github.com/kucherenko/jscpd)
  over the repository. If the session added a block that repeats code elsewhere, drygate
  shows the user the list of copies. It warns and never blocks the turn: Claude Code shares
  one `stop_hook_active` flag between all Stop hooks, so a block from drygate would use up
  the one refusal another Stop hook relies on.
- **A sweep**, `/drygate:sweep`, for code jscpd cannot see: functions that reimplement the
  standard library or an installed dependency, and wrappers that add nothing. Haiku scouts
  read the code in parallel batches and Sonnet verifies every candidate before it is
  reported.
- **jscpd's MCP server**, so the agent can check a draft against the codebase before it
  writes it (Claude Code only).

It works in Claude Code and Codex. It needs Node 20 or later and git. The check does nothing
outside a git repository.

## Install

Claude Code:

```
/plugin marketplace add NovusEdge/drygate
/plugin install drygate@drygate
```

Codex:

```sh
codex plugin marketplace add NovusEdge/drygate
codex plugin add drygate@drygate
```

Codex runs a plugin's hooks only after you review and trust them in `/hooks`. Codex plugins
cannot ship agents or an MCP server that needs the project path, so in Codex the sweep runs
its passes as plain subagents, and the MCP server is added by hand:

```sh
codex mcp add jscpd -- npx --yes jscpd@5.4.2 --mcp .
```

On a Nimble Fox repo, install it from the team marketplace instead: `drygate@nimble-fox`.

### jscpd

Nothing to install by hand. drygate uses a jscpd 5.4 or later from `PATH` if there is one.
Otherwise the first session installs jscpd 5.4.2 with npm into the plugin's data directory,
once per machine, in the background; until that finishes, stops are not checked and say so.
A failed install, for example offline or behind a proxy npm cannot reach, is retried after
10 minutes. To use a specific binary, set `DRYGATE_JSCPD` to its path.

## How the check decides

At session start, drygate scans the working tree in a background process and counts the
clones by the pair of files they join and by the code they repeat. At each stop it scans
again and warns on a clone when both its file pair and its code are more common than in
the snapshot. After every checked stop, the snapshot moves forward to the current tree, so
each copy is reported once.

- Duplication that was already there, committed or not, is never reported. Editing an old
  clone, renaming its file or moving it is not reported either.
- A third copy of code that was already duplicated is reported.
- A copy the agent commits before it stops is still reported. drygate compares against the
  snapshot, not against `HEAD`.
- A copy with its local names changed still counts (renamed-identifier matching).
- On resume, drygate takes a new snapshot, so commits pulled in between are not reported.
  Uncommitted changes since the last check stay out of it: a turn the user interrupted had
  no stop, so they are still checked.
- A stop with no file changed since the last check skips the scan.
- If jscpd cannot run, drygate warns the user and lets the turn end.

The scan leaves out test, fixture, vendored, generated and minified files, and data and doc
formats (Markdown, JSON, YAML). It always leaves out git worktrees, submodules and nested
clones inside the repository. The minimum clone size is jscpd's default, 50 tokens.

On a 193,000-line C# repository, a stop that has to scan takes about 2.5 seconds and a stop
with nothing changed about 0.15 seconds. Session start returns in about 0.1 seconds; its
snapshot finishes in the background a few seconds later.

## Configuration

A `.jscpd.json` at the repository root replaces drygate's defaults: the ignore list,
renamed-copy detection and any other jscpd option. drygate still adds worktrees,
submodules and nested clones to its `ignore` list. See jscpd's
[options](https://github.com/kucherenko/jscpd#options).

To keep a deliberate duplicate out of the report, wrap it in comments the check skips:

```js
// jscpd:ignore-start
...
// jscpd:ignore-end
```

`DRYGATE_DISABLE=1` in the environment turns the check off.

## Limits

- The warning goes to the user, not to the agent: a Stop hook cannot add to the model's
  context without blocking. In an unattended session nobody sees it; run
  `/drygate:sweep` or review the diff instead.
- The check finds copies of text: exact copies, renamed copies and near-copies. It does not
  find two functions that do the same thing written differently. The sweep covers part of
  that: code the standard library or a dependency already provides.
- Removing one clone and adding a different one between the same two files, in the same
  turn, is not caught: the counts do not change.
- A clone that existed before the session, in a file the agent edits before the start
  snapshot finishes, counts as new and is reported once. The snapshot takes a few seconds at most,
  and in an interactive session the first edit comes after the user's first prompt.
- The sweep reads every file in scope with a model. It reports the batch and line counts
  first and asks before sweeping more than 300,000 lines.
- Tested on Linux. macOS and Windows are untested.

## Development

```sh
node --test tests/drygate.test.js
```

The tests run the hook against real git repositories and a real jscpd, which they install
once through the hook's own install path.

## License

MIT
