// Runs hooks/drygate.js the way Claude Code does: JSON on stdin, plugin env
// vars set, a real git repo and a real jscpd.
//
// Each test gets a fresh data dir, so without DRYGATE_JSCPD every test would
// install jscpd again. The suite installs it once through the hook's own
// install path and points DRYGATE_JSCPD at that copy.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOOK = path.join(__dirname, '..', 'hooks', 'drygate.js');

if (!process.env.DRYGATE_JSCPD) {
  const shared = fs.mkdtempSync(path.join(os.tmpdir(), 'drygate-install-'));
  const r = spawnSync('node', ['-e', "process.stdout.write(require('./hooks/jscpd').command({ allowInstall: true }))"], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, CLAUDE_PLUGIN_DATA: shared },
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  process.env.DRYGATE_JSCPD = r.stdout;
}

test('the jscpd drygate runs is 5.4 or newer', () => {
  const r = spawnSync(process.env.DRYGATE_JSCPD, ['--version'], { encoding: 'utf8', shell: process.platform === 'win32' });
  assert.match(r.stdout, /jscpd 5\.([4-9]|\d\d)\./);
});

const PARSER = `export function parseUser(input) {
  const parts = input.split(",");
  const name = parts[0].trim();
  const email = parts[1].trim().toLowerCase();
  if (!email.includes("@")) {
    throw new Error("invalid email: " + email);
  }
  const age = parseInt(parts[2], 10);
  if (Number.isNaN(age) || age < 0) {
    throw new Error("invalid age: " + parts[2]);
  }
  return { name, email, age };
}
`;

const OTHER = `export function sum(xs) {
  return xs.reduce((a, b) => a + b, 0);
}
`;

function repo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drygate-repo-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 't');
  write(dir, files);
  git('add', '-A');
  git('commit', '-qm', 'init');
  return { dir, git };
}

function write(dir, files) {
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
}

function session(dir, opts = {}) {
  const data = opts.data || fs.mkdtempSync(path.join(os.tmpdir(), 'drygate-data-'));
  const id = opts.id || 'sess-1';
  const env = {
    ...process.env,
    CLAUDE_PROJECT_DIR: dir,
    CLAUDE_PLUGIN_DATA: data,
    ...(opts.env || {}),
  };
  const run = (input, extra = {}) => {
    const r = spawnSync('node', [HOOK], {
      input: JSON.stringify({ session_id: id, cwd: dir, ...input }),
      env: { ...env, ...extra },
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, `hook exited ${r.status}: ${r.stderr}`);
    return r.stdout.trim() ? JSON.parse(r.stdout) : null;
  };
  // SessionStart returns before its background snapshot finishes. Tests wait
  // for it unless they are about that race.
  const settle = () => {
    const dir = path.join(data, 'sessions');
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (!fs.existsSync(dir) || !fs.readdirSync(dir).some((f) => f.endsWith('.pending'))) return;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
    assert.fail('snapshot did not finish');
  };
  return {
    data,
    start: (source = 'startup', { wait = true } = {}) => {
      const out = run({ hook_event_name: 'SessionStart', source });
      if (wait) settle();
      return out;
    },
    stop: (active = false, extra) => run({ hook_event_name: 'Stop', stop_hook_active: active }, extra),
  };
}

const BROKEN = { DRYGATE_JSCPD: path.join(os.tmpdir(), 'no-such-jscpd') };
const WARN = /drygate: this session added duplicated code/;

test('a turn that adds no duplication stops normally', () => {
  const { dir } = repo({ 'src/a.js': PARSER });
  const s = session(dir);
  s.start();
  write(dir, { 'src/sum.js': OTHER });
  assert.equal(s.stop(), null);
});

test('a new copy of existing code warns without blocking and names both files', () => {
  const { dir } = repo({ 'src/a.js': PARSER });
  const s = session(dir);
  s.start();
  write(dir, { 'src/b.js': PARSER.replace('parseUser', 'parseAdmin') });
  const out = s.stop();
  assert.equal(out.decision, undefined);
  assert.match(out.systemMessage, WARN);
  assert.match(out.systemMessage, /src\/b\.js:1-13 repeats src\/a\.js:1-13/);
});

test('the file written later is named as the copy, whichever side jscpd lists first', () => {
  const { dir } = repo({ 'src/z.js': PARSER });
  const s = session(dir);
  s.start();
  write(dir, { 'src/a.js': PARSER.replace('parseUser', 'parseAdmin') });
  assert.match(s.stop().systemMessage, /src\/a\.js:1-13 repeats src\/z\.js:1-13/);
});

test('a copy with renamed locals still warns', () => {
  const { dir } = repo({ 'src/a.js': PARSER });
  const s = session(dir);
  s.start();
  const renamed = PARSER.replace(/parts/g, 'fields').replace(/email/g, 'mail').replace('parseUser', 'parseGuest');
  write(dir, { 'src/c.js': renamed });
  assert.match(s.stop()?.systemMessage ?? '', WARN);
});

test('a copy committed before the stop still warns', () => {
  const { dir, git } = repo({ 'src/a.js': PARSER });
  const s = session(dir);
  s.start();
  write(dir, { 'src/b.js': PARSER.replace('parseUser', 'parseAdmin') });
  git('add', '-A');
  git('commit', '-qm', 'copy');
  assert.match(s.stop()?.systemMessage ?? '', WARN);
});

test('a copy committed while the background snapshot runs still warns', () => {
  const { dir, git } = repo({ 'src/a.js': PARSER });
  const s = session(dir);
  s.start('startup', { wait: false });
  write(dir, { 'src/b.js': PARSER.replace('parseUser', 'parseAdmin') });
  git('add', '-A');
  git('commit', '-qm', 'copy');
  assert.match(s.stop()?.systemMessage ?? '', WARN);
});

test('editing a clone that existed at session start does not warn', () => {
  const { dir } = repo({ 'src/a.js': PARSER, 'src/legacy.js': PARSER.replace('parseUser', 'parseLegacy') });
  const s = session(dir);
  s.start();
  const legacy = fs.readFileSync(path.join(dir, 'src/legacy.js'), 'utf8');
  write(dir, { 'src/legacy.js': legacy.replace('invalid age: ', 'bad age: ') });
  assert.equal(s.stop(), null);
});

test('a second copy between files that already shared one warns', () => {
  const { dir } = repo({ 'src/a.js': PARSER + '\n' + OTHER, 'src/legacy.js': PARSER.replace('parseUser', 'parseLegacy') });
  const s = session(dir);
  s.start();
  const big = OTHER.replace('return', 'const total = xs.reduce((a, b) => a + b, 0);\n  const mean = total / xs.length;\n  const sq = xs.map((x) => (x - mean) * (x - mean));\n  return { total, mean, variance: sq.reduce((a, b) => a + b, 0) / xs.length };\n  return');
  write(dir, { 'src/a.js': PARSER + '\n' + big });
  const legacy = fs.readFileSync(path.join(dir, 'src/legacy.js'), 'utf8');
  write(dir, { 'src/legacy.js': legacy + '\n' + big.replace('sum', 'total') });
  assert.match(s.stop()?.systemMessage ?? '', WARN);
});

test('renaming a file that held old duplication does not warn', () => {
  const { dir, git } = repo({ 'src/a.js': PARSER, 'src/legacy.js': PARSER.replace('parseUser', 'parseLegacy') });
  const s = session(dir);
  s.start();
  git('mv', 'src/legacy.js', 'src/legacy2.js');
  assert.equal(s.stop(), null);
});

test('a third copy of code that was already duplicated warns', () => {
  const { dir } = repo({ 'src/a.js': PARSER, 'src/legacy.js': PARSER.replace('parseUser', 'parseLegacy') });
  const s = session(dir);
  s.start();
  write(dir, { 'src/b.js': PARSER.replace('parseUser', 'parseAdmin') });
  const out = s.stop();
  assert.match(out?.systemMessage ?? '', WARN);
  assert.match(out.systemMessage, /src\/b\.js/);
});

test('a duplicate is reported once, not on later turns', () => {
  const { dir } = repo({ 'src/a.js': PARSER });
  const s = session(dir);
  s.start();
  write(dir, { 'src/b.js': PARSER.replace('parseUser', 'parseAdmin') });
  assert.match(s.stop().systemMessage, WARN);
  assert.equal(s.stop(), null);
  write(dir, { 'src/sum.js': OTHER });
  assert.equal(s.stop(), null);
});

test('resume takes a new snapshot, so code pulled in between does not warn', () => {
  const { dir, git } = repo({ 'src/a.js': PARSER });
  const s = session(dir);
  s.start();
  write(dir, { 'src/teammate.js': PARSER.replace('parseUser', 'parseTeam') });
  git('add', '-A');
  git('commit', '-qm', 'pulled');
  s.start('resume');
  assert.equal(s.stop(), null);
});

test('a repo cloned two levels deep inside the project is not scanned', () => {
  const { dir } = repo({ 'src/a.js': PARSER });
  const s = session(dir);
  s.start();
  write(dir, { 'scratch/r/x.js': PARSER.replace('parseUser', 'parseX') });
  execFileSync('git', ['init', '-q'], { cwd: path.join(dir, 'scratch/r') });
  assert.equal(s.stop(), null);
});

test('nested repos with commas or non-ASCII in their names are not scanned', () => {
  const { dir } = repo({ 'src/a.js': PARSER });
  const s = session(dir);
  s.start();
  for (const name of ['a,b', 'café']) {
    write(dir, { [`${name}/x.js`]: PARSER.replace('parseUser', 'parseX') });
    execFileSync('git', ['init', '-q'], { cwd: path.join(dir, name) });
  }
  assert.equal(s.stop(), null);
});

test('input that is not JSON makes the hook do nothing, with exit 0', () => {
  const r = spawnSync('node', [HOOK], { input: 'x', encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

test("the user's uncommitted duplication from before the session does not warn", () => {
  const { dir } = repo({ 'src/a.js': PARSER });
  write(dir, { 'src/wip.js': PARSER.replace('parseUser', 'parseWip') });
  const s = session(dir);
  s.start();
  assert.equal(s.stop(), null);
});

test('a stop continued by another Stop hook still warns and never blocks', () => {
  const { dir } = repo({ 'src/a.js': PARSER });
  const s = session(dir);
  s.start();
  write(dir, { 'src/b.js': PARSER.replace('parseUser', 'parseAdmin') });
  const out = s.stop(true);
  assert.equal(out.decision, undefined);
  assert.match(out.systemMessage, /src\/b\.js/);
});

test('a copy from an interrupted turn, which had no stop, still warns after resume', () => {
  const { dir } = repo({ 'src/a.js': PARSER });
  const s = session(dir);
  s.start('startup');
  write(dir, { 'src/b.js': PARSER.replace('parseUser', 'parseAdmin') });
  s.start('resume');
  assert.match(s.stop()?.systemMessage ?? '', WARN);
});

test('a stop with no baseline takes one and lets the turn end', () => {
  const { dir } = repo({ 'src/a.js': PARSER });
  write(dir, { 'src/b.js': PARSER.replace('parseUser', 'parseAdmin') });
  const s = session(dir);
  assert.equal(s.stop(), null);
  write(dir, { 'src/c.js': PARSER.replace('parseUser', 'parseGuest') });
  assert.match(s.stop()?.systemMessage ?? '', WARN);
});

test("the repo's own .jscpd.json replaces drygate's defaults", () => {
  const { dir } = repo({ 'src/a.js': PARSER, '.jscpd.json': '{"minTokens": 500}' });
  const s = session(dir);
  s.start();
  write(dir, { 'src/b.js': PARSER.replace('parseUser', 'parseAdmin') });
  assert.equal(s.stop(), null);
});

test('a git worktree created inside the repo during the session does not warn', () => {
  const { dir, git } = repo({ 'src/a.js': PARSER });
  const s = session(dir);
  s.start();
  git('worktree', 'add', '-q', '.claude/worktrees/w');
  assert.equal(s.stop(), null);
});

test("worktrees are skipped on top of the ignore list in the repo's .jscpd.json", () => {
  const { dir, git } = repo({ 'src/a.js': PARSER, '.jscpd.json': '{"ignore": ["**/gen/**"]}' });
  const s = session(dir);
  s.start();
  git('worktree', 'add', '-q', '.claude/worktrees/w');
  write(dir, { 'gen/a.js': PARSER.replace('parseUser', 'parseGen') });
  assert.equal(s.stop(), null);
});

test('test files are ignored by default', () => {
  const { dir } = repo({ 'src/a.test.js': PARSER });
  const s = session(dir);
  s.start();
  write(dir, { 'src/b.test.js': PARSER.replace('parseUser', 'parseAdmin') });
  assert.equal(s.stop(), null);
});

test('outside a git repository the hook does nothing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drygate-plain-'));
  write(dir, { 'a.js': PARSER, 'b.js': PARSER.replace('parseUser', 'parseAdmin') });
  const s = session(dir);
  assert.equal(s.start(), null);
  assert.equal(s.stop(), null);
  assert.deepEqual(fs.readdirSync(s.data), []);
});

test('a jscpd that fails to run warns the user and never blocks', () => {
  const { dir } = repo({ 'src/a.js': PARSER });
  const s = session(dir, { env: BROKEN });
  assert.equal(s.start(), null);
  write(dir, { 'src/b.js': PARSER.replace('parseUser', 'parseAdmin') });
  const out = s.stop();
  assert.equal(out.decision, undefined);
  assert.match(out.systemMessage, /drygate/);
});

test('a stop with no file changed since the last clean check does not scan', () => {
  const { dir } = repo({ 'src/a.js': PARSER });
  const s = session(dir);
  s.start();
  write(dir, { 'src/sum.js': OTHER });
  assert.equal(s.stop(), null);
  assert.equal(s.stop(false, BROKEN), null);
  write(dir, { 'src/sum.js': OTHER + '\n' });
  assert.match(s.stop(false, BROKEN).systemMessage, /drygate/);
});

test('a file written while the background snapshot runs still counts as new', () => {
  const { dir } = repo({ 'src/a.js': PARSER });
  const s = session(dir);
  s.start('startup', { wait: false });
  write(dir, { 'src/b.js': PARSER.replace('parseUser', 'parseAdmin') });
  assert.match(s.stop()?.systemMessage ?? '', WARN);
});

test('DRYGATE_DISABLE=1 turns the hook off', () => {
  const { dir } = repo({ 'src/a.js': PARSER });
  const s = session(dir, { env: { DRYGATE_DISABLE: '1' } });
  s.start();
  write(dir, { 'src/b.js': PARSER.replace('parseUser', 'parseAdmin') });
  assert.equal(s.stop(), null);
});
