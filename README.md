# mend

[![make.fun](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/aldi235/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/aldi235/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

mend is one command-line tool that applies the edits AI models write, in four
formats, to a tree of text files — exactly as the competition's `SPEC.md`
(version 1) specifies. Every file is changed or nothing is.

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- **Unified diffs** (`--format=unified`): hunks apply by content, not by their
  (often wrong) line numbers — each hunk takes the occurrence nearest to its
  stated position, adjusted for the drift earlier hunks caused. Creations,
  deletions, renames and moves included, with `\ No newline at end of file`
  handling.
- **SEARCH/REPLACE blocks** (`--format=search-replace`): each block names its
  file, replaces its old lines (or creates the file when the old side is
  empty), and fails `ambiguous` when the old lines occur more than once.
- **V4A patches** (`--format=v4a`): `*** Add File` / `*** Delete File` /
  `*** Update File` sections with `@@` anchors, a moving cursor and
  `*** End of File` anchoring.
- **JSON tool calls** (`--format=json`): `create`, `str_replace` and `insert`
  edits, as one JSON array or JSON Lines.

Lines match at the first of three tiers — exact, then trailing whitespace
ignored, then indentation ignored (`--strict` tries exact only) — and at the
indentation tier, added lines are re-indented to the file's own indent.
CRLF files keep CRLF, files without a final line break keep that, and
`--check` reports what would change without writing anything.

`main.ts` is the whole CLI: Node 22 and the standard library alone, no
dependencies. `runner.ts` is the kit's trial runner, kept as shipped: when
`MAKEFUN_ENV_URL` is set, `main.ts` hands the trial over to it.

## Exit codes

- `0` — every edit applied; stdout lists each changed path (`A`/`D`/`M`, or
  `R old -> new` for a move) and ends with `ok: N files`.
- `1` — one or more edits failed (`no-match`, `ambiguous`, `missing`,
  `exists`, `unsafe`); nothing is written, and every failure is reported.
- `2` — usage error, unreadable patch, undetected format, or a parse error,
  each as a single `error: ...` line.

## License

MIT — see `LICENSE`.
