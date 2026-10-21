#!/usr/bin/env node
// Blocks the end of a turn that added duplicated code. Claude Code and Codex
// both run it with the event JSON on stdin and read a decision from stdout.
//
// SessionStart snapshots the clones in the working tree, per session. Stop
// scans again and blocks on clones the session added. The snapshot is of the
// working tree, not of a git ref: jscpd --changed rebuilds its baseline when
// HEAD moves, so a copy the agent committed before stopping went unreported.
//
// Never exits non-zero. A broken or missing jscpd warns the user and lets the
// turn end; a gate that fails closed would stop every session in the repo.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const jscpd = require('./jscpd');

// A snapshot older than this with no result is from a process that died.
const PENDING_TTL = 5 * 60 * 1000;
// Stop waits this long for a snapshot still running; the hook timeout is 120 s.
const PENDING_WAIT = 90 * 1000;

function scan(root, extra, ignore = []) {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'drygate-'));
  const args = ['.', '-r', 'json', '-o', out, ...jscpd.options(root, ignore), ...extra];
  const r = spawnSync(jscpd.command(), args, { cwd: root, encoding: 'utf8', shell: jscpd.shell, timeout: 100_000 });
  let report = null;
  try {
    report = JSON.parse(fs.readFileSync(path.join(out, 'jscpd-report.json'), 'utf8'));
  } catch {}
  fs.rmSync(out, { recursive: true, force: true });
  if (!report) {
    const why = (r.error && r.error.message) || r.stderr.trim().split('\n').pop() || `exit ${r.status}`;
    throw new Error(why);
  }
  return report.duplicates;
}

function byPair(clones) {
  const pairs = new Map();
  for (const c of clones) {
    const key = [c.firstFile.name, c.secondFile.name].sort().join('\0');
    pairs.set(key, [...(pairs.get(key) || []), c]);
  }
  return pairs;
}

// Files git reports as changed or untracked, with their mtime and size.
function changes(root) {
  const r = spawnSync('git', ['status', '--porcelain=v1', '-z', '-uall'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 256 << 20,
  });
  const files = [];
  for (const entry of (r.stdout || '').split('\0')) {
    const name = entry.slice(3);
    if (!name) continue;
    try {
      const st = fs.statSync(path.join(root, name));
      files.push({ name, mtime: st.mtimeMs, size: st.size });
    } catch {
      files.push({ name, mtime: 0, size: -1 });
    }
  }
  return files;
}

// Equal fingerprints mean the tree jscpd would scan has not changed.
function fingerprint(root) {
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout || '';
  const h = crypto.createHash('sha1').update(head);
  for (const f of changes(root)) h.update(`${f.name}\0${f.mtime}\0${f.size}\0`);
  return h.digest('hex');
}

// Tracked and untracked files modified after `since`. Read from ls-files, not
// status: a file the agent wrote and committed while the snapshot ran is no
// longer in git status.
function touchedSince(root, since) {
  const r = spawnSync('git', ['ls-files', '-z', '-co', '--exclude-standard'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 256 << 20,
  });
  return (r.stdout || '').split('\0').filter((name) => {
    try {
      return name && fs.statSync(path.join(root, name)).mtimeMs > since;
    } catch {
      return false;
    }
  });
}

// `since` is when SessionStart ran. A file modified after it is the session's
// work, so it stays out of the snapshot and its clones count as added at Stop.
// The cost: a clone that existed before, in a file the agent edits before the
// snapshot finishes, also counts as added. The snapshot takes up to a few
// seconds; an interactive session's first edit comes after the user's prompt.
function snapshot(root, state, since) {
  fs.mkdirSync(state.dir, { recursive: true });
  const touched = since ? touchedSince(root, since) : [];
  const clones = scan(root, ['--baseline', state.baseline, '--update-baseline'], touched);
  const counts = Object.fromEntries([...byPair(clones)].map(([k, v]) => [k, v.length]));
  // The rename makes the pairs file appear only once complete; Stop polls for it.
  fs.writeFileSync(`${state.pairs}.tmp`, JSON.stringify(counts));
  fs.renameSync(`${state.pairs}.tmp`, state.pairs);
}

// jscpd takes seconds on a large repo, and the first run in a machine installs
// it. SessionStart hands the snapshot to a detached process so the session's
// first prompt does not wait for either.
function startSnapshot(root, state) {
  fs.mkdirSync(state.dir, { recursive: true });
  const since = Date.now();
  fs.writeFileSync(state.pending, String(since));
  spawn(process.execPath, [__filename], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, DRYGATE_SNAPSHOT: JSON.stringify({ root, state, since }) },
  }).unref();
}

function runSnapshotJob() {
  const { root, state, since } = JSON.parse(process.env.DRYGATE_SNAPSHOT);
  try {
    snapshot(root, state, since);
  } catch (e) {
    fs.writeFileSync(state.error, e.message);
  }
  fs.rmSync(state.pending, { force: true });
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function awaitSnapshot(state) {
  let since;
  try {
    since = Number(fs.readFileSync(state.pending, 'utf8'));
  } catch {
    return;
  }
  if (Date.now() - since > PENDING_TTL) return;
  const deadline = Date.now() + PENDING_WAIT;
  while (fs.existsSync(state.pending) && !fs.existsSync(state.pairs) && Date.now() < deadline) sleep(100);
}

// A clone counts as added when its file pair has more clones than at session
// start. jscpd's own isNew is not enough: editing one literal inside a clone
// that already existed changes its fingerprint, and old debt would then block
// unrelated work.
function added(root, state) {
  const before = JSON.parse(fs.readFileSync(state.pairs, 'utf8'));
  const found = [];
  for (const [key, clones] of byPair(scan(root, ['--baseline', state.baseline]))) {
    if (clones.length <= (before[key] || 0)) continue;
    const fresh = clones.filter((c) => c.isNew);
    found.push(...(fresh.length ? fresh : clones));
  }
  return found;
}

function where(f) {
  return `${f.name}:${f.start}-${f.end}`;
}

// jscpd orders a clone's two sides by path, not by age. The side in the file
// modified last is the one the session wrote, so it is named as the copy.
function describe(root, c) {
  const mtime = (f) => {
    try {
      return fs.statSync(path.join(root, f.name)).mtimeMs;
    } catch {
      return 0;
    }
  };
  const [copy, original] =
    mtime(c.firstFile) > mtime(c.secondFile) ? [c.firstFile, c.secondFile] : [c.secondFile, c.firstFile];
  return `- ${where(copy)} repeats ${where(original)} (${c.lines} lines)`;
}

function stop(input, root, state) {
  if (!fs.existsSync(state.pairs)) awaitSnapshot(state);
  if (fs.existsSync(state.error)) {
    const why = fs.readFileSync(state.error, 'utf8');
    fs.rmSync(state.error, { force: true });
    throw new Error(why);
  }
  if (!fs.existsSync(state.pairs)) {
    // No snapshot for this session: the data dir was cleared, or the plugin was
    // installed mid-session. Take one now; the next turn is checked against it.
    snapshot(root, state);
    return null;
  }
  // Checked only after a pass: a stop right after a block must scan again so
  // the second stop can report what is left.
  const fp = fingerprint(root);
  if (fs.existsSync(state.passed) && fs.readFileSync(state.passed, 'utf8') === fp) return null;
  const clones = added(root, state);
  if (!clones.length) {
    fs.writeFileSync(state.passed, fp);
    return null;
  }
  fs.rmSync(state.passed, { force: true });
  const list = clones.map((c) => describe(root, c)).join('\n');
  if (input.stop_hook_active) {
    return { systemMessage: `drygate: this session's changes still duplicate code:\n${list}` };
  }
  return {
    decision: 'block',
    reason:
      `drygate: this session added duplicated code.\n${list}\n\n` +
      'Remove each duplicate before you finish: call or import the existing code, or move the ' +
      'shared part into one function that both places use. If the user wants a duplicate kept, ' +
      'wrap it in jscpd:ignore-start and jscpd:ignore-end comments and say so in your reply.',
  };
}

function stateFor(input, root) {
  const dir = path.join(jscpd.dataDir(), 'sessions');
  // One session can move between repositories; each gets its own snapshot.
  const repo = crypto.createHash('sha1').update(root).digest('hex').slice(0, 10);
  const base = path.join(dir, `${String(input.session_id || 'none').replace(/[^\w-]/g, '_')}-${repo}`);
  return {
    dir,
    baseline: `${base}.baseline.json`,
    pairs: `${base}.pairs.json`,
    pending: `${base}.pending`,
    error: `${base}.error`,
    passed: `${base}.passed`,
  };
}

function prune(dir) {
  const week = 7 * 24 * 3600 * 1000;
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    const p = path.join(dir, f);
    if (Date.now() - fs.statSync(p).mtimeMs > week) fs.rmSync(p, { force: true });
  }
}

function main() {
  if (process.env.DRYGATE_DISABLE === '1') return null;
  const input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  const root = jscpd.gitRoot(process.env.CLAUDE_PROJECT_DIR || input.cwd);
  if (!root) return null;
  const state = stateFor(input, root);
  try {
    if (input.hook_event_name === 'SessionStart') {
      prune(state.dir);
      if (!fs.existsSync(state.pairs) && !fs.existsSync(state.pending)) startSnapshot(root, state);
      return null;
    }
    if (input.hook_event_name === 'Stop') return stop(input, root, state);
  } catch (e) {
    return { systemMessage: `drygate: jscpd did not run, so this turn was not checked: ${e.message}` };
  }
  return null;
}

if (process.env.DRYGATE_SNAPSHOT) {
  runSnapshotJob();
} else {
  const out = main();
  if (out) process.stdout.write(JSON.stringify(out));
}
