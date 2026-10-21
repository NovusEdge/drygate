---
name: drygate
description: Use before writing a new function, class, component or module, and when a drygate message reports duplicated code. Covers finding existing code to reuse and removing a duplicate.
---

# drygate

drygate's Stop hook runs jscpd when you finish a turn. If the session added a block of 50 or
more tokens that repeats code elsewhere in the repository, the turn does not end: you get the
list of copies and must remove them first. A copy with its local names changed still counts.
Duplication that existed when the session started does not block.

## Before you write new code

1. Search for code that already does the job. Grep for the operation's verbs and nouns, the
   types it takes and returns, and the error messages it would raise. Check the modules the
   calling code already imports.
2. If the jscpd MCP tools are available, call `check_duplication` with your draft and its
   language before you write it to a file. Drafts shorter than 50 tokens return a note, not a
   match.
3. Reuse what you find. If it almost fits, add a parameter to it or split out the shared part.
   Do not copy it and change the copy.

## When drygate blocks

Each line of the message reads `new.js:10-30 repeats old.js:4-24 (21 lines)`. For each one:

- Replace the copy with a call to the original, or
- move the shared part into one function that both places call. Put it next to the original,
  or in a module both files already import.

Do not reorder statements or rename variables to get under the detector. The duplicate is
still there, and renamed copies are detected anyway.

Keep a duplicate only when the user asks for it, or when the code is generated, or when the
two modules must not depend on each other. Wrap it in `jscpd:ignore-start` and
`jscpd:ignore-end` comments, in the file's comment syntax, and tell the user which block you
kept and why.

If you stop again with copies still there, the turn ends and the user sees the list.

## Configuration

A `.jscpd.json` at the repository root replaces drygate's defaults: the 50-token minimum,
renamed-copy detection, and the ignored test, fixture, vendored, generated and data files.
`DRYGATE_DISABLE=1` in the environment turns the hook off.
