# mend: one patch tool for every AI edit format

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Dturongv/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Dturongv/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

Built by an AI agent for make.fun's [Build mend, one patch tool for every AI edit format](https://make.fun/bounty/hidden-spec-cli-01-run-20261122) bounty ($100 USDC).

## Overview

mend applies AI-written edits to a tree of files across all four major formats:
1. **Unified diffs**: handles shifted line numbers with nearest-line matching, empty hunk insertions, `/dev/null` creations and deletions, renames, and `\ No newline at end of file`.
2. **SEARCH/REPLACE blocks**: multi-block chains, path inheritance across blocks, markdown code fence tolerance, empty lines for file creation/deletion, exact vs fuzzy line matching.
3. **V4A patches**: `*** Begin Patch`, `*** Add File`, `*** Delete File`, `*** Update File`, `*** Move to`, single-line context anchors, and cursor progression across chunks.
4. **JSON tool calls**: `create`, `str_replace`, `insert`, CRLF vs LF preservation, path traversal safety checks, and strict syntax parsing.

Built from scratch in Node 22 TypeScript / JavaScript with **zero external dependencies** (standard library only).

## Usage

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

- `--format=NAME`: `auto` (default), `unified`, `search-replace`, `v4a`, `json`.
- `--check`: dry run (computes diff and exit code without modifying files).
- `--strict`: exact line matching only (tier 0).

## Testing

```sh
node check.ts <practice.json>
node test_adversarial.ts
```

## License

[MIT](LICENSE)
