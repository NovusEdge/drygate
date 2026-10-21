// How drygate finds jscpd, what it tells jscpd to skip, and the repository to
// scan. drygate.js and mcp.js both use it, so the gate and the MCP server run
// the same jscpd with the same options.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// The gate's results depend on jscpd's JSON report, so the copy drygate
// installs is pinned to the version the tests ran against.
const VERSION = '5.4.2';

// npm and an npm-installed jscpd are .cmd shims on Windows, which spawn cannot
// start without a shell; through a shell, arguments with spaces need quotes.
const shell = process.platform === 'win32';
const quote = (s) => (shell && /[\s&()^|<>]/.test(s) ? `"${s}"` : s);

function run(cmd, args, opts = {}) {
  return spawnSync(quote(cmd), args.map(quote), { encoding: 'utf8', shell, windowsHide: true, ...opts });
}

// Claude Code sets CLAUDE_PLUGIN_DATA and Codex sets PLUGIN_DATA; both keep it
// across plugin updates.
function dataDir() {
  return process.env.CLAUDE_PLUGIN_DATA || process.env.PLUGIN_DATA || path.join(os.tmpdir(), 'drygate');
}

function onPath() {
  const r = run('jscpd', ['--version']);
  const m = r.status === 0 && /(\d+)\.(\d+)\.\d+/.exec(r.stdout);
  // Older than 5.4 lacks consistent identifier matching.
  return Boolean(m && (+m[1] > 5 || (+m[1] === 5 && +m[2] >= 4)));
}

const installDir = () => path.join(dataDir(), `jscpd-${VERSION}`);
const installedBin = () => path.join(installDir(), 'node_modules', '.bin', shell ? 'jscpd.cmd' : 'jscpd');
const failedMarker = () => path.join(dataDir(), 'install-failed');
const RETRY_AFTER = 10 * 60 * 1000;

// npx re-resolves the package on every call, about 2.5 s, and Stop runs every
// turn. A copy installed once into the data dir starts in about 0.1 s.
//
// Only the background snapshot process calls this: an install takes seconds
// online and can hang for minutes behind a proxy, longer than a Stop hook may
// run. A failure is remembered for RETRY_AFTER so each turn does not retry it.
function install() {
  fs.mkdirSync(dataDir(), { recursive: true });
  try {
    if (Date.now() - fs.statSync(failedMarker()).mtimeMs < RETRY_AFTER) {
      throw new Error(`npm install jscpd@${VERSION} failed recently: ${fs.readFileSync(failedMarker(), 'utf8')}`);
    }
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  // The MCP server and a snapshot can install at once. Each installs into its
  // own directory and renames it into place; the loser's rename fails because
  // the target exists, and it uses the winner's copy.
  const tmp = fs.mkdtempSync(path.join(dataDir(), '.install-'));
  try {
    const r = run('npm', ['install', '--prefix', tmp, '--no-audit', '--no-fund', '--silent', `jscpd@${VERSION}`], {
      timeout: 110_000,
    });
    if (r.status !== 0) {
      const why = (r.stderr || (r.error && r.error.message) || `exit ${r.status}`).trim().split('\n').pop();
      fs.writeFileSync(failedMarker(), why);
      throw new Error(`npm install jscpd@${VERSION} failed: ${why}`);
    }
    fs.rmSync(failedMarker(), { force: true });
    fs.renameSync(tmp, installDir());
  } catch (e) {
    if (!fs.existsSync(installedBin())) throw e;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// Returns the jscpd to run, or null when none is installed and `allowInstall`
// is false.
function command({ allowInstall }) {
  if (process.env.DRYGATE_JSCPD) return process.env.DRYGATE_JSCPD;
  if (onPath()) return 'jscpd';
  if (!fs.existsSync(installedBin()) && allowInstall) install();
  return fs.existsSync(installedBin()) ? installedBin() : null;
}

function gitRoot(dir) {
  if (!dir) return null;
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

function git(root, args) {
  const r = spawnSync('git', ['-c', 'core.quotepath=false', ...args], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 256 << 20,
  });
  return (r.stdout || '').split('\0').filter(Boolean);
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
// clones and block the turn. git lists an untracked directory that holds a
// .git, at any depth, as one entry ending in a slash.
function nested(root) {
  const untracked = git(root, ['ls-files', '-z', '--others', '--exclude-standard']).filter((p) => p.endsWith('/'));
  const submodules = git(root, ['ls-files', '-z', '--stage'])
    .filter((l) => l.startsWith('160000 '))
    .map((l) => l.slice(l.indexOf('\t') + 1));
  return [...untracked, ...submodules].map((p) => `${p.replace(/\/$/, '')}/**`);
}

// Writes the jscpd config for a scan of `root` to `file` and returns the CLI
// args that use it. A config file, not --ignore: jscpd splits --ignore on
// commas, and its --ignore replaces the ignore list in .jscpd.json rather than
// adding to it. The repo's own .jscpd.json, when present, is the base.
function config(root, file, more = []) {
  const own = path.join(root, '.jscpd.json');
  let base = null;
  if (fs.existsSync(own)) {
    try {
      base = JSON.parse(fs.readFileSync(own, 'utf8'));
    } catch {
      // jscpd reports the broken file itself when it loads it.
      return [];
    }
  }
  const cfg = base
    ? { ...base, ignore: [...(base.ignore || []), ...nested(root), ...more] }
    : // consistent: a copy with its locals renamed is caught, but only where
      // each name maps to one name on the other side, so `x = x + x` is not
      // `a = b + c`.
      { ignore: [...IGNORE, ...nested(root), ...more], ignoreIdentifiers: 'consistent' };
  fs.writeFileSync(file, JSON.stringify(cfg));
  return ['-c', file];
}

module.exports = { VERSION, run, dataDir, command, gitRoot, git, config };
