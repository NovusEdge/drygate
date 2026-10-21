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
  args = [...args, ...jscpd.options(root)];
} else {
  root = path.join(os.tmpdir(), 'drygate-empty');
  fs.mkdirSync(root, { recursive: true });
}

// cwd is the repo so the relative ignore globs from options() resolve there.
const child = spawn(jscpd.command(), args, { cwd: root, stdio: 'inherit', shell: jscpd.shell });
child.on('exit', (code, signal) => process.exit(signal ? 1 : code));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
