# Verifier instructions

Each candidate came from a scout on a small model. Treat it as a lead, not a fact: scouts
name functions that do not exist and miss what a body really does. Try to prove each one
wrong.

For each candidate:

1. Open the function and read all of it.
2. Check that the replacement exists, under that name and signature, in the language or
   dependency version you were given. If you cannot confirm it from the installed package,
   its type stubs or its official documentation, the verdict is REJECTED.
3. Check that the replacement behaves the same for every input the callers pass. Grep the
   call sites. Look for edge cases the body handles: empty input, `None` or `null`, NaN,
   rounding mode, locale, encoding, order, mutation of the argument.
4. Check that nothing requires the function to exist: an interface, protocol or trait it
   implements; a mocking or test seam; a public API that other packages import; a language
   that needs the explicit conversion; a shim for an older runtime the repo still supports.

Write one line per candidate:

```
CONFIRMED | path/to/file.py:42 | chunk | itertools.batched(items, n) | 3 call sites
REJECTED | path/to/file.py:90 | to_int | int(x) does not strip the "px" suffix this one strips
```

A CONFIRMED line gives the exact replacement code and the number of call sites. A REJECTED
line gives the reason in under 20 words. When unsure, reject.

Do not edit any file.
