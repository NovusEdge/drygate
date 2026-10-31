#!/usr/bin/env node
// Warns at the end of a turn that added duplicated code. Claude Code and Codex
// both run it with the event JSON on stdin and read a decision from stdout.
//
// It warns instead of blocking because every Stop hook shares one
// stop_hook_active flag: a block from drygate used up the one refusal another
// plugin's Stop hook relies on, such as a harness that refuses to end a turn
// before its agent has reported.
//
// SessionStart snapshots the clones in the working tree. Stop scans again and
// warns on clones the session added, then moves the snapshot forward. The
// snapshot is of the working tree, not of a git ref: jscpd --changed rebuilds
// its baseline when HEAD moves, so a copy the agent committed before stopping
// went unreported.
//
// Always exits 0 and reports through systemMessage. Exit 2 from a Stop hook
// blocks the turn, and a crash shows an error on every turn in every repo that
// enables the plugin.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const jscpd = require('./jscpd');

// A snapshot older than this with no result is from a process that died.
const PENDING_TTL = 10 * 60 * 1000;
// The Stop hook's timeout is 120 s: up to 60 s waiting for a running snapshot,
// then up to 50 s for its own scan.
const PENDING_WAIT = 60 * 1000;
const STOP_SCAN_TIMEOUT = 50 * 1000;

function scan(root, { allowInstall, timeout, ignore = [] }) {
  const cmd = jscpd.command({ allowInstall });
  if (!cmd) return null;
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'drygate-'));
  try {
    const cfg = jscpd.config(root, path.join(out, 'config.json'), ignore);
    const r = jscpd.run(cmd, ['.', '-r', 'json', '-o', out, ...cfg], { cwd: root, timeout });
    try {
      return JSON.parse(fs.readFileSync(path.join(out, 'jscpd-report.json'), 'utf8')).duplicates;
    } catch {
      if (r.error && r.error.code === 'ETIMEDOUT') throw new Error(`jscpd took longer than ${timeout / 1000} s`);
      throw new Error((r.error && r.error.message) || (r.stderr || '').trim().split('\n').pop() || `exit ${r.status}`);
    }
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
}

const pairOf = (c) => [c.firstFile.name, c.secondFile.name].sort().join('\0');
// What a clone repeats, wherever it sits. Renaming a file or shifting lines
// keeps it; editing the code changes it.
const contentOf = (c) => crypto.createHash('sha1').update(c.fragment.replace(/\s+/g, ' ').trim()).digest('hex');

function tally(clones) {
  const pairs = {};
  const contents = {};
  for (const c of clones) {
    pairs[pairOf(c)] = (pairs[pairOf(c)] || 0) + 1;
    contents[contentOf(c)] = (contents[contentOf(c)] || 0) + 1;
  }
  return { pairs, contents };
}

// A clone counts as added when both its file pair and its content are more
// common than in the snapshot. Pair alone fails on a rename: the moved file
// forms a new pair with the same old clone. Content alone fails on an edit
// inside an old clone, which changes its content but adds nothing. Not caught:
// removing one clone and adding a different one between the same two files.
function added(before, clones) {
  const now = tally(clones);
  return clones.filter(
    (c) =>
      now.pairs[pairOf(c)] > (before.pairs[pairOf(c)] || 0) &&
      now.contents[contentOf(c)] > (before.contents[contentOf(c)] || 0)
  );
}

// Files git reports as changed or untracked. With -z, a rename or copy entry
// is followed by a second entry holding its old path.
function changes(root) {
  const entries = jscpd.git(root, ['status', '--porcelain=v1', '-z', '-uall']);
  const files = [];
  for (let i = 0; i < entries.length; i++) {
    const name = entries[i].slice(3);
    if ('RC'.includes(entries[i][0])) i++;
    try {
      const st = fs.statSync(path.join(root, name));
      files.push(`${name}\0${st.mtimeMs}\0${st.size}`);
    } catch {
      files.push(`${name}\0gone`);
    }
  }
  return files;
}

// Equal fingerprints mean the tree jscpd would scan has not changed.
function fingerprint(root) {
  const h = crypto.createHash('sha1').update(jscpd.git(root, ['rev-parse', 'HEAD']).join(''));
  for (const f of changes(root)) h.update(`${f}\0`);
  return h.digest('hex');
}

// Tracked and untracked files modified after `since`. Read from ls-files, not
// status: a file the agent wrote and committed while the snapshot ran is no
// longer in git status.
function touchedSince(root, since) {
  return jscpd.git(root, ['ls-files', '-z', '-co', '--exclude-standard']).filter((name) => {
    try {
      return fs.statSync(path.join(root, name)).mtimeMs > since;
    } catch {
      return false;
    }
  });
}

function save(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Stop polls for this file, so it must appear only once complete.
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(data));
  fs.renameSync(`${file}.tmp`, file);
}

// `since` is when SessionStart ran. A file modified after it is the session's
// work, so it stays out of the snapshot and its clones count as added at Stop.
// The cost: a clone that existed before, in a file the agent edits before the
// snapshot finishes, also counts as added. The snapshot takes up to a few
// seconds; an interactive session's first edit comes after the user's prompt.
//
// `checked` is set on resume: the last time a Stop checked the tree. Claude
// Code runs no Stop for an interrupted turn, so uncommitted files changed since
// then are unchecked work and stay out too. Committed changes since then, such
// as a pull, are other people's and go in.
function runSnapshotJob() {
  const { root, state, since, checked } = JSON.parse(process.env.DRYGATE_SNAPSHOT);
  try {
    const ignore = touchedSince(root, since);
    if (checked) {
      const dirty = new Set(changes(root).map((f) => f.split('\0')[0]));
      ignore.push(...touchedSince(root, checked).filter((f) => dirty.has(f)));
    }
    const clones = scan(root, { allowInstall: true, timeout: 300_000, ignore });
    if (!clones) throw new Error('jscpd is not installed and could not be installed');
    save(state.snapshot, tally(clones));
  } catch (e) {
    fs.writeFileSync(state.error, e.message);
  }
  fs.rmSync(state.pending, { force: true });
}

// jscpd takes seconds on a large repo, and the first run on a machine installs
// it. The snapshot runs in a detached process so neither holds up the session.
function startSnapshot(root, state, checked = null) {
  fs.mkdirSync(state.dir, { recursive: true });
  const since = Date.now();
  fs.writeFileSync(state.pending, String(since));
  spawn(process.execPath, [__filename], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, DRYGATE_SNAPSHOT: JSON.stringify({ root, state, since, checked }) },
  }).unref();
}

function pendingSince(state) {
  try {
    const since = Number(fs.readFileSync(state.pending, 'utf8'));
    return Date.now() - since < PENDING_TTL ? since : null;
  } catch {
    return null;
  }
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
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
  if (pendingSince(state)) {
    const deadline = Date.now() + PENDING_WAIT;
    while (pendingSince(state) && Date.now() < deadline) sleep(100);
  }
  if (fs.existsSync(state.error)) {
    const why = fs.readFileSync(state.error, 'utf8');
    fs.rmSync(state.error, { force: true });
    throw new Error(why);
  }
  if (!fs.existsSync(state.snapshot)) {
    if (pendingSince(state)) throw new Error('the session snapshot is still running');
    // No snapshot: the data dir was cleared, or the plugin was installed
    // mid-session. This turn's changes would be in a snapshot taken now, so
    // take it in the background and check from the next turn on.
    startSnapshot(root, state);
    return null;
  }
  const fp = fingerprint(root);
  if (fs.existsSync(state.passed) && fs.readFileSync(state.passed, 'utf8') === fp) return null;
  const clones = scan(root, { allowInstall: false, timeout: STOP_SCAN_TIMEOUT });
  if (!clones) {
    startSnapshot(root, state);
    throw new Error('jscpd is being installed in the background');
  }
  const before = JSON.parse(fs.readFileSync(state.snapshot, 'utf8'));
  const found = added(before, clones);
  // The snapshot always moves forward, so each duplicate is reported once.
  save(state.snapshot, tally(clones));
  fs.writeFileSync(state.passed, fp);
  if (!found.length) return null;
  const list = found.map((c) => describe(root, c)).join('\n');
  return { systemMessage: `drygate: this session added duplicated code:\n${list}` };
}

function stateFor(input, root) {
  const dir = path.join(jscpd.dataDir(), 'sessions');
  // One session can move between repositories; each gets its own snapshot.
  const repo = crypto.createHash('sha1').update(root).digest('hex').slice(0, 10);
  const base = path.join(dir, `${String(input.session_id || 'none').replace(/[^\w-]/g, '_')}-${repo}`);
  return {
    dir,
    snapshot: `${base}.snapshot.json`,
    pending: `${base}.pending`,
    error: `${base}.error`,
    passed: `${base}.passed`,
  };
}

function prune() {
  const old = (p, ms) => {
    try {
      return Date.now() - fs.statSync(p).mtimeMs > ms;
    } catch {
      return false;
    }
  };
  const data = jscpd.dataDir();
  const sessions = path.join(data, 'sessions');
  for (const f of fs.existsSync(sessions) ? fs.readdirSync(sessions) : []) {
    if (old(path.join(sessions, f), 7 * 24 * 3600 * 1000)) fs.rmSync(path.join(sessions, f), { force: true });
  }
  // Left by an npm install that was killed mid-way.
  for (const f of fs.existsSync(data) ? fs.readdirSync(data) : []) {
    const p = path.join(data, f);
    if (f.startsWith('.install-') && old(p, 3600 * 1000)) fs.rmSync(p, { recursive: true, force: true });
  }
}

function main() {
  if (process.env.DRYGATE_DISABLE === '1') return null;
  let input;
  try {
    input = JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch {
    return null;
  }
  const root = jscpd.gitRoot(process.env.CLAUDE_PROJECT_DIR || input.cwd);
  if (!root) return null;
  const state = stateFor(input, root);
  if (input.hook_event_name === 'SessionStart') {
    prune();
    // On resume the session may be days old and the tree has moved on: other
    // people's commits are not the session's work and must not block it.
    const resumed = input.source === 'resume' && fs.existsSync(state.snapshot);
    if ((resumed || !fs.existsSync(state.snapshot)) && !pendingSince(state)) {
      startSnapshot(root, state, resumed ? fs.statSync(state.snapshot).mtimeMs : null);
    }
    return null;
  }
  if (input.hook_event_name === 'Stop') return stop(input, root, state);
  return null;
}

if (process.env.DRYGATE_SNAPSHOT) {
  runSnapshotJob();
} else {
  let out = null;
  try {
    out = main();
  } catch (e) {
    out = { systemMessage: `drygate: this turn was not checked for duplicated code: ${e.message}` };
  }
  if (out) process.stdout.write(JSON.stringify(out));
}
