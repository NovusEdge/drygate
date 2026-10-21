---
name: sweep
description: Sweep a codebase for functions that reimplement the standard library or an installed dependency, and for wrappers that add nothing. Haiku scouts flag candidates and Sonnet verifies each one. Run as /drygate:sweep [changed | paths...].
argument-hint: "[changed | paths...]"
disable-model-invocation: true
---

# drygate sweep

Find code that should not exist because the language or an installed package already
provides it. Examples:

- a `chunk(list, n)` helper in Python 3.12, which has `itertools.batched`
- a `deepClone` that does what `structuredClone` does
- `toFloat(x: float) -> float`, or any function that converts a value to the type it
  already has
- a wrapper whose body is one call to a builtin, with nothing added

The stop gate catches copies of code inside the repo. This sweep catches what the gate
cannot. Report first; change nothing until the user picks what to fix.

## 1. Scope

The repository is `git rev-parse --show-toplevel`. With no arguments, sweep every source
file in `git ls-files`. With `changed`, sweep the files that differ from the merge base with
the default branch, plus uncommitted ones. With paths, sweep those.

Leave out tests, fixtures, vendored, generated and minified files, and data or docs formats.
If a `.jscpd.json` has an `ignore` list, leave those out too.

## 2. Context for the agents

Collect, from the manifests at the root and in packages:

- each language and the version the repo targets: `pyproject.toml` `requires-python`,
  `package.json` `engines` and TypeScript `target`, `go.mod` `go`, `Cargo.toml`
  `rust-version` or edition, `*.csproj` `TargetFramework`, Unity's `ProjectVersion.txt`
- the direct dependencies, by name

Without a stated version, say "version not stated" rather than guessing one.

## 3. Batches

Group the files by directory into batches of about 2,000 lines (`wc -l`). Keep a file
whole even when it is larger. Tell the user the file count, line count and batch count. Above
300,000 lines, ask before you continue.

## 4. Scout

Dispatch one `drygate:scout` agent per batch, up to eight at a time. Give each one the
contents of `references/scout.md` in this skill's directory, the context from step 2, and its
file list. Scouts read and report; they never edit.

## 5. Verify

Collect the candidate lines. Drop exact repeats. Split them into groups of about 15, by
file, and dispatch one `drygate:verifier` agent per group, with the contents of
`references/verifier.md`, the context from step 2 and its candidates.

Keep only CONFIRMED verdicts. A scout's claim is never a finding on its own: scouts run
on a small model that names APIs that do not exist.

## 6. Report

A table of confirmed findings, most removable code first:

| Location | Function | Replace with | Call sites | Kind |
| --- | --- | --- | --- | --- |

Below it, one line with the number of candidates rejected and the most common reason. Then
ask which findings to fix. When you fix one, replace each call site, delete the function,
and run the repo's tests.

In a tool without the drygate agents (Codex), run each scout and verifier as a plain
subagent with the same instructions, or work through the batches yourself in the same order.
