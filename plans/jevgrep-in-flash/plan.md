# Bring jevgrep's benefits into Flash

**Branch:** `main` (one commit per step, pushed straight to `main`)
**Description:** Add jevgrep's answer cache, verbatim source excerpts, repo-scale `flash search`, safer file filtering and a real provider health check to Flash, keeping it zero-dependency.

## Goal
jevgrep is strong at one job: answering "where is X in this repo?" with files, line ranges and verbatim code, measured end to end. Flash is generic (filter/classify/rank/find/ask) but its `find` returns single lines and it has no cache, no tests and no repo traversal. Porting the portable parts gives Flash jevgrep-grade code retrieval without its `typescript` / Pyodide dependencies.

Source: jevgrep v0.4.3 (`adbea4c`), MIT, © 2026 David Zhang. Code or prompt text copied from it keeps that notice (see Step 9).

## Out of scope
- Real AST parsing (`typescript` package, Pyodide). A heuristic scanner stands in (Step 7).
- Python-only extras: call context, test-body pruning, relation-anchor re-exploration.
- A SWE-bench harness. Step 8 adds a retrieval task to the existing `bench/` instead.

## Implementation Steps

### Step 1: Test harness with a fake Jev server ✅ done
**Files:** `test/fake-jev.mjs` (new), `test/flash.test.mjs` (new), `package.json` (`"test": "node --test test/"`)
**What:** `node:test` + `node:http` server that answers `{answers:{id:{type,…}}}` and records request bodies. Tests run `flash.mjs` as a subprocess with `FLASH_API_BASE` pointing at the server and `FLASH_HOME` in a temp dir. First tests cover current behavior: filter/classify/find output, footer format (the `guard.mjs` regex depends on it), retry on 429, exit 3 on 401, and history rows.
**Testing:** `npm test` passes on Node 18 and 22 with no network.

### Step 2: File filtering hardening ✅ done
**Files:** `skills/flash/scripts/flash.mjs` (`collect`, `walk`, `readText`), `test/flash.test.mjs`
**What:** Port jevgrep's content checks. Skip files containing a `-----BEGIN … PRIVATE KEY-----` block. Treat control characters or invalid UTF-8 as binary, not only NUL. Skip symlinks. Never read `~/.flash`. Honor `.ignore` on the non-git walk path.
**Testing:** fixture dir with a planted `DO_NOT_UPLOAD` private key, a symlink and a binary; the test asserts none of them reaches any request body.

### Step 3: Answer cache in `decide()` ✅ done
**Files:** `flash.mjs` (`decide`, new `cacheGet`/`cachePut`, `gain`, `HELP`), `test/flash.test.mjs`
**What:** Key = sha256 of `{schema, provider, base, model, promptVersion, body}`. Store answers only, never source, in `~/.flash/cache/<hash>.json`: directory 0700, files 0600, atomic write via temp file + rename, 7-day TTL, size cap. Source text is part of the body, so an edited file misses the cache automatically. Add `--no-cache` and `flash cache clear`. Cached hits count 0 Jev tokens, and `gain` shows the hit rate.
The cache is **on by default**, as in jevgrep.
**Testing:** running the same `filter` twice makes one request to the fake server; editing the file makes a new request; `--no-cache` always calls; cache files are 0600 and contain no source text.

### Step 4: Real provider health check ✅ done
**Files:** `flash.mjs` (`PROVIDERS`, `cmdStatus`, `checkKey`), `test/flash.test.mjs`
**What:** Keep the current providers and endpoints (TypeSafe `/v1/systemone` with `jev-latest`, OpenRouter `/api/alpha/decisions`), both verified live; add no new providers. Replace the per-provider key-check endpoints (`/v1/models`, `/v1/key`) with jevgrep's doctor approach: one real, synthetic decision call that must answer p > 0.5. This proves the key *and* the decision endpoint work, the same way for every provider. Redact the key from error text.
**Testing:** `flash status --provider <p>` against the fake server (ok, 401, low probability); live `status` with the real TypeSafe and OpenRouter keys.

### Step 5: Verbatim source excerpts for `find` ✅ done
**Files:** `flash.mjs` (`cmdFind`, new `renderContext`), `SKILL.md`, `skills/flash/scripts/guard.mjs` (hint text), `test/flash.test.mjs`
**What:** Add `--context` to `find`. Each hit becomes `Source block "path" lines a-b:` in a fence longer than any backtick run inside the excerpt. Hits get ±3 lines, widened to take in adjacent comments; overlapping ranges merge. Output ends with `End context.`, and `--max-source-bytes` caps the total. Claude then needs no follow-up `Read`. The guard's hint recommends `find --context`.
**Testing:** fixture with known line ranges; the test checks merged ranges, a fence around source that itself contains backticks, the byte cap, and the end marker. Measure output tokens against today's `find` + `Read`.

### Step 6: `flash search "<query>" [root]`: folder → file → chunk traversal ✅ done
**Files:** `flash.mjs` (new `cmdSearch`, `previewDirectory`, `packNouls`), `HELP`, `SKILL.md`, `test/flash.test.mjs`
**What:** Port jevgrep's `discover` loop:
- List root and first-level folders without asking Jev.
- Deeper folders get a preview (up to 64 child names or 4 KB, counts, extensions); files get 12 KB chunks.
- Each item gets one yes/no question that names its path or line range. Folders > 0.5 are explored; files > 0.5 become candidates, keeping each file's best chunk score.
- Candidates go through Step 5's excerpt renderer. A request budget flag bounds cost: `--max-requests`, default 1000. jevgrep used 365–815 packed requests per query, and unpacked needs more; tune the default in Step 8.
- **One item per request by default**, since Flash's bench measured packing at 76% accuracy vs 100% unpacked. `--fast` packs like jevgrep (up to 128 items or 38 KB, each question naming its path), and a packed request that fails is split in half and retried.

**Testing:** fake server with scripted probabilities checks that pruned folders are never read, that the budget holds, and that `--fast` packs and splits on failure; live run on the hono corpus that `bench/` already uses.

### Step 7: Declaration units and file roles (heuristic) ✅ done
**Files:** `skills/flash/scripts/units.mjs` (new; installers copy the whole skill dir), `flash.mjs` (`cmdSearch`), `test/units.test.mjs`
**What:**
- Split candidate files into declarations. Python uses an indentation scan for `def`/`class` (decorators, class header as a context unit). JS/TS uses a brace-and-keyword heuristic for top-level `function`/`class`/`const … =>`/`export`. Anything else falls back to 3 KB text chunks.
- Ask jevgrep's two questions per unit ("directly implements or tests the behavior", "belongs to the queried API"), value = min. Thresholds: select > 0.5, reading lead > 0.25, display > 0.7.
- One extra request per candidate labels its role (implementation, caller, test, fixture, helper) to order the output.

Only the heuristic path is built. An exact Python `ast` pass through a system `python3` gets added only if the Step 8 bench shows the heuristic missing spans.
**Testing:** unit tests on fixture Python/TS files with known declaration spans, including a decorator, a nested class, an arrow function, and a file that fails the heuristic and must fall back to text.

### Step 8: Retrieval benchmark and jevgrep's accounting rules ✅ done
**Files:** `bench/truth/s13.json` (new), `bench/prompts.md`, `bench/run-flash.mjs`, `bench/score.mjs`, `bench/README.md`
**What:** New situation on hono: truth = files + line ranges for a "where is X" question. Score file recall, range hit, and output tokens for `find` (old), `find --context` and `search`, against the Claude-alone baseline. Adopt jevgrep's accounting rules: freeze the baseline and never rerun it, keep failed runs, report Jev cost separately from Claude tokens, and treat missing cost as unknown rather than zero.
**Testing:** `node bench/score.mjs` reproduces the numbers; results committed under `bench/results/`.

### Step 9: Docs, attribution, release ✅ done
**Files:** `NOTICE` (new), `README.md`, `skills/flash/SKILL.md`, `AGENT-SETUP.md`, `package.json` (version), `.claude-plugin/plugin.json` (version)
**What:** Credit jevgrep's MIT notice for the ported algorithm and prompt texts. Document `search`, `find --context`, the cache and the new `status` check. Update the SKILL.md command table so Claude picks `search` for code questions and `filter`/`classify` for everything else, and add the new flags to the agent runbook. Bump the version.
**Testing:** `npm test` green; reinstall with `./install.sh`; a live `flash search` in this repo; the guard hint and PostToolUse footer still fire in Claude Code.
