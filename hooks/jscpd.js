// How drygate finds jscpd and the repository to scan. drygate.js and mcp.js
// both use it, so the gate and the MCP server always run the same jscpd.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// The gate's results depend on jscpd's clone fingerprints and JSON report, so
// the copy drygate installs is pinned to the version the tests ran against.
const VERSION = '5.4.2';

// npm and an npm-installed jscpd are .cmd shims on Windows, which spawn cannot
// start without a shell.
const shell = process.platform === 'win32';

// Claude Code sets CLAUDE_PLUGIN_DATA and Codex sets PLUGIN_DATA; both keep it
// across plugin updates.
function dataDir() {
  return process.env.CLAUDE_PLUGIN_DATA || process.env.PLUGIN_DATA || path.join(os.tmpdir(), 'drygate');
}

function onPath() {
  const r = spawnSync('jscpd', ['--version'], { encoding: 'utf8', shell });
  const m = r.status === 0 && /(\d+)\.(\d+)\.\d+/.exec(r.stdout);
  // Older than 5.4 lacks --update-baseline and the report's isNew field.
  return Boolean(m && (+m[1] > 5 || (+m[1] === 5 && +m[2] >= 4)));
}

// npx re-resolves the package on every call, about 2.5 s, and Stop runs every
// turn. A copy installed once into the data dir starts in about 0.1 s.
function installed() {
  const dir = path.join(dataDir(), `jscpd-${VERSION}`);
  const bin = path.join(dir, 'node_modules', '.bin', shell ? 'jscpd.cmd' : 'jscpd');
  if (fs.existsSync(bin)) return bin;
  fs.mkdirSync(dataDir(), { recursive: true });
  // The MCP server and SessionStart can both get here at once. Each installs
  // into its own directory and renames it into place; the loser's rename fails
  // because the target exists, and it uses the winner's copy.
  const tmp = fs.mkdtempSync(path.join(dataDir(), '.install-'));
  const r = spawnSync('npm', ['install', '--prefix', tmp, '--no-audit', '--no-fund', '--silent', `jscpd@${VERSION}`], {
    encoding: 'utf8',
    shell,
    timeout: 110_000,
  });
  try {
    if (r.status !== 0) throw new Error(`npm install jscpd@${VERSION} failed: ${(r.stderr || r.error?.message || '').trim()}`);
    fs.renameSync(tmp, dir);
  } catch (e) {
    if (!fs.existsSync(bin)) throw e;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return bin;
}

function command() {
  if (process.env.DRYGATE_JSCPD) return process.env.DRYGATE_JSCPD;
  return onPath() ? 'jscpd' : installed();
}

function gitRoot(dir) {
  if (!dir) return null;
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

// Test copies and generated or data files repeat by design, and a gate that
// fires on them gets turned off. A repo's own .jscpd.json replaces this list.
const IGNORE = [
  '**/*.test.*', '**/*.spec.*', '**/*_test.*', '**/test_*.py',
  '**/test/**', '**/tests/**', '**/__tests__/**', '**/fixtures/**', '**/testdata/**',
  '**/vendor/**', '**/dist/**', '**/build/**', '**/generated/**',
  '**/*.generated.*', '**/*.pb.go', '**/*_pb2.py', '**/*.min.*',
  '**/*.md', '**/*.json', '**/*.yaml', '**/*.yml', '**/*.lock', '**/*.svg',
];

// Worktrees, submodules and nested clones inside the repo: each is a whole
// copy of some tree, untracked but not gitignored, so jscpd scans it. A
// worktree the agent creates mid-session would show up as hundreds of new
// clones and block the turn.
function nested(root) {
  const git = (...args) =>
    spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 256 << 20 }).stdout || '';
  const worktrees = git('worktree', 'list', '--porcelain')
    .split('\n')
    .filter((l) => l.startsWith('worktree '))
    .map((l) => path.relative(root, l.slice('worktree '.length)));
  const submodules = git('ls-files', '--stage')
    .split('\n')
    .filter((l) => l.startsWith('160000 '))
    .map((l) => l.split('\t')[1]);
  const clones = git('ls-files', '--others', '--exclude-standard', '--directory')
    .split('\n')
    .filter((d) => d.endsWith('/') && fs.existsSync(path.join(root, d, '.git')));
  return [...new Set([...worktrees, ...submodules, ...clones])]
    .map((p) => p.replace(/\/$/, ''))
    .filter((p) => p && !p.startsWith('..') && !path.isAbsolute(p))
    .map((p) => `${p}/**`);
}

// jscpd's --ignore replaces the ignore list in .jscpd.json rather than adding
// to it, and a second --ignore replaces the first. So every pattern goes in
// one flag: the repo's own list, the nested trees, and the caller's extras.
function options(root, more = []) {
  const file = path.join(root, '.jscpd.json');
  let config = null;
  if (fs.existsSync(file)) {
    try {
      config = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      config = {};
    }
  }
  const ignore = [...(config ? config.ignore || [] : IGNORE), ...nested(root), ...more];
  // consistent: a copy with its locals renamed is caught, but only where each
  // name maps to one name on the other side, so `x = x + x` is not `a = b + c`.
  const args = config ? [] : ['--ignore-identifiers=consistent'];
  return ignore.length ? [...args, '--ignore', ignore.join(',')] : args;
}

module.exports = { VERSION, shell, dataDir, command, gitRoot, options };
