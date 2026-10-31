# drygate

- `hooks/drygate.js` is the one hook for Claude Code and Codex. Both send the same Stop and
  SessionStart JSON and read `systemMessage` from stdout. Codex has no
  `CLAUDE_PROJECT_DIR`, so the hook falls back to the stdin `cwd`.
- The Stop hook warns and never returns `{"decision":"block"}`. All Stop hooks share one
  `stop_hook_active` flag, so a drygate block let flocc's Stop hook end a turn its agent
  had not finished.
- The hook must exit 0 on every path and report everything as `systemMessage`. Exit 2 from a
  Stop hook blocks the turn, and a crash shows a hook error on every turn in every repo that
  enables the plugin.
- `VERSION` in `hooks/jscpd.js` pins the jscpd that drygate installs. The warning rule reads
  jscpd's JSON report (`fragment`, file names), so bump it only with the tests passing
  against the new version.
- Options reach jscpd through a temp config file from `config()`, never `--ignore`: jscpd
  splits `--ignore` on commas, and it replaces `.jscpd.json`'s `ignore` instead of adding.
- A Stop hook never installs jscpd; only the detached snapshot process does. An install can
  outlast the 120 s hook timeout.
- The tests install jscpd with npm on the first run, so they need network once.
- Keep `.claude-plugin/plugin.json` and `.codex-plugin/plugin.json` at the same version; CI
  checks it.
- Conventional Commits, `git commit -s`. Decisions are in docket (`docket list`).
