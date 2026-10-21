#!/usr/bin/env node
// Starts jscpd's MCP server on the git repository of the project directory in
// argv[2]. jscpd --mcp scans its path at startup, so a session opened in a home
// directory would scan all of it. Outside a repository it serves an empty
// directory instead: the server still connects and its tools find no clones.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const jscpd = require('./jscpd');

let root = jscpd.gitRoot(process.argv[2] || process.env.CLAUDE_PROJECT_DIR || process.cwd());
let args = ['--mcp', '.'];
if (root) {
  const file = path.join(jscpd.dataDir(), `mcp-${process.pid}.json`);
  fs.mkdirSync(jscpd.dataDir(), { recursive: true });
  args = [...args, ...jscpd.config(root, file)];
  process.on('exit', () => fs.rmSync(file, { force: true }));
} else {
  root = path.join(os.tmpdir(), 'drygate-empty');
  fs.mkdirSync(root, { recursive: true });
}

// Before the first snapshot has installed jscpd, npx fetches it. Installing
// here instead would hold the server past Claude Code's MCP startup timeout.
let cmd = jscpd.command({ allowInstall: false });
if (!cmd) {
  cmd = 'npx';
  args = ['--yes', `jscpd@${jscpd.VERSION}`, ...args];
}

const child = spawn(cmd, args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32', windowsHide: true });
child.on('error', (e) => {
  process.stderr.write(`drygate: could not start jscpd's MCP server: ${e.message}\n`);
  process.exit(1);
});
child.on('exit', (code, signal) => process.exit(signal ? 1 : code));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
