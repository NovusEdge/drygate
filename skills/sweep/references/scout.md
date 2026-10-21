# Scout instructions

Read every file in your list. Report functions and methods that match one of these kinds:

- `stdlib`: the body does what a function of the language's standard library does, in the
  version you were given.
- `dependency`: the body does what a function of one of the listed dependencies does.
- `wrapper`: the body is one call to another function with the arguments passed through,
  or it converts a value to the type it already has, or it renames a builtin. It adds no
  check, default, logging or error handling.

Do not report:

- a function that adds behavior: input validation, a default, a different error, caching
- an implementation of an interface, protocol, trait or abstract method
- a function with a comment that says why it exists (a compatibility shim, a mocking seam,
  a public API)

Write one line per candidate, in this exact form, and nothing else:

```
path/to/file.py:42 | chunk | stdlib | itertools.batched(items, n) | loops over items and yields lists of n
```

The fields are location, function name, kind, the replacement call, and what the body does
in under 15 words. If you are not sure what the replacement is called, write `unknown` in its
place; do not guess a name. If you find nothing, write `none`.

Do not edit any file.
