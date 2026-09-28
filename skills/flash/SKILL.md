---
name: flash
description: Offload bulk judgment calls to Jev (TypeSafe's fast System One model) so Claude doesn't read, and pay for, content it only needs a verdict on. Use this BEFORE reading many files, long logs, or big lists just to decide which parts matter. That covers code questions like "where is X implemented?" (`flash search`), finding which files relate to a feature or bug, filtering log lines for errors, triaging or labelling many items (tickets, test failures, commits, TODOs, search hits), ranking candidates by relevance, locating the right lines in a huge file, or a yes/no check on a large document. Also use when the user says flash, jev, "save tokens", "delegate", or "cheaper/faster". Skip it for generation, editing, multi-step reasoning, math, counting, or date comparison, and when the input is small enough to just read.
---

# Flash: let Jev make the calls, Claude does the thinking

Jev returns **typed judgments** (yes/no probability, one-of-N label, rubric score)
in about a second, at $0.042 per million input tokens. It cannot write text or reason in
steps. So the split is simple: **Jev narrows, Claude reads only what survives.**
Every item Jev rules out is content that never enters Claude's context. That
saves tokens, saves usage limits, and cuts wall-clock time, because Jev scans
hundreds of items in parallel.

In the commands below, `flash` stands for:

```bash
node "<base directory of this skill>/scripts/flash.mjs"
```

Needs Node 18+ (globs need Node 22+). There are no other dependencies.

## First run: set the key once

Run `flash status` first.

- `ready` means go straight to the task.
- `not configured` means the user needs a key. Jev is reachable through two
  providers with the same answers:
  - **TypeSafe**: key from **https://console.typesafe.ai**
  - **OpenRouter**: key from **https://openrouter.ai/settings/keys**, add `--provider openrouter`

  Ask the user to run this in their own prompt, so the key never enters the chat:

  ```
  ! node "<base directory of this skill>/scripts/flash.mjs" setup --provider openrouter
  ```

  It prompts with hidden input, verifies the key, saves it to `~/.flash/config.json`
  (user-only permissions) and makes that provider the default. If the key is already in
  an environment variable or `~/.env`, pipe it in instead:
  `printenv OPENROUTER_API_KEY | flash setup --provider openrouter`.

  Env keys also work and take precedence over saved ones: `JEV_API_KEY` or
  `TYPESAFE_API_KEY` for TypeSafe, `OPENROUTER_API_KEY` for OpenRouter.
  After setup, carry on with the original task. Don't stop at "configured".

Exit codes: 2 bad usage (run `flash help <command>`), 3 key missing or rejected (re-run
setup), 4 Jev rejected the request, 5 network error.

## When to delegate

Ask: *"Am I about to read a lot of content only to decide which parts matter?"*
If yes, and each decision fits yes/no, pick-a-label, or rate-on-a-scale, delegate.

| Situation | Command |
| --- | --- |
| "Where is X implemented?" in a codebase | `flash search "how is X done?" src` (walks folders, prints the relevant files with source) |
| "Which files deal with X?" as a flat list | `flash filter "Does this file implement or handle X?" src` |
| Errors or anomalies in a big log | `flash filter "Does this line indicate a failure?" app.log --lines` |
| Where in a 5k-line file is Y? | `flash find "Y" big_file.py --top 5 --context` |
| Sort 200 tickets, test failures, or TODOs into buckets | `flash classify --labels "bug,feature,question" --items items.jsonl` |
| Best candidates for a query (search hits, docs, files) | `flash rank "query" docs/ --top 10` |
| One yes/no over a large document | `flash ask "Does this contract allow termination without notice?" --state @contract.txt` |
| Several questions over the same content | `flash ask spec.json` (raw request, see below) |

**Benchmarked strengths** (12 real tasks, see the repo's `bench/`): Flash matched Claude's
accuracy while cutting its tokens by 77–96% on needle-in-haystack log search, finding
files across a repo, "where is X?" ranking, semantic search inside huge files, and bulk
routing or classification with clear labels (support intents, CI failure causes,
sentiment). It was weaker on subjective or expert-defined labels (commit types, alert
policies) and on look-alike code (safe vs vulnerable twins). There, use its output as a
shortlist, and check the `?` items yourself.

**Don't delegate:**
- Tiny inputs (a few files, or under ~2k tokens). Just read them.
- Exact matches. `grep` or `rg` is free and exact. Jev is for *meaning*: "handles
  auth" rather than the literal string `auth`.
- Arithmetic, counting, date or time comparison. Do those in code.
- Anything generative (writing, summarizing, editing) or needing a chain of reasoning.
- Content the user wouldn't want sent to a third-party API. Flash already
  skips `.env*`, keys, certs, and credentials files, and respects `.gitignore`.

## When a Read is blocked

Flash's hook refuses whole-file `Read`s of files over 600 lines or 60 KB. Don't work
around it with `cat` or a huge `limit`. Locate what you need first, then read only there:

```bash
flash find "<what you need from the file>" path/to/big_file --top 5 --context
```

`--context` prints the source around each hit (3 lines each side, widened to the comment
above it, nearby hits merged), so usually no `Read` is needed. If you need more, `Read`
with `offset`/`limit` around the hit lines. For logs, use
`flash filter "<question>" app.log --lines` instead of `find`.

## When an MCP response is trimmed

A hook trims big MCP list responses. The output then starts with `[flash: Jev kept N of M items …]` and names the file with the full response. Work from the kept items. If the answer seems missing, Read that file with offset/limit, or run `flash filter`/`find` on it with a sharper question. Don't re-run the MCP call to get the rest.

## Commands

**Inputs** (for filter, classify, rank): files, directories (respects
`.gitignore` inside git repos, and skips `node_modules`, `dist`, and similar),
globs, `-` for stdin, or `--items FILE.jsonl` (one JSON object per line with
`id` and `text`, or plain text lines). Add `--lines` to judge each line
separately (logs, CSVs, lists). Use `--ext ts,tsx` to limit file types.

```bash
flash filter "<yes/no question>" <inputs> [--threshold 0.5] [--lines]
flash classify --labels "a,b,c" <inputs> [--question "..."] [--only a] [--min-confidence 0.6]
flash classify --labels-json '{"bug":"Something is broken","feature":"A request for new behaviour"}' <inputs>
flash rank "<query>" <inputs> [--top 10 | --all]
flash search "<question about the code>" [root] [--top 10] [--max-requests 1000] [--fast] [--no-source]
flash find "<what you're looking for>" <files> [--top 5] [--context [N]] [--max-source-bytes 20000]
flash ask "<question>" --state @file|"text"|- [--choice "a,b,c" | --score "low|mid|high"]
flash ask spec.json        # {"state": ..., "questions": {"id": {"type": "noul|choice|score", ...}}}
flash status               # key check, plus lifetime tokens saved
flash gain                 # tokens saved by command, project and day
flash help <command>       # flags and examples for one command
```

Answers are cached for 7 days in `~/.flash/cache` (answers only, never content). Re-running a
command over unchanged content is free and instant; edited content is asked again. Pass
`--no-cache` to force fresh answers, `flash cache clear` to wipe it.

Results go to stdout. The summary footer, skipped files and errors go to stderr, so
`flash filter ... | xargs` gets only results. Add `--json` for machine-readable output.
`--save FILE` writes every per-item result to FILE, while stdout stays compact.
`--fast` packs small items into shared requests. It's about 10× faster on big logs, but
less accurate on subtle judgments. Use it for obvious needles (crashes, OOMs) in very
large logs, not for classification.

## Reading the output

Output is compact on purpose. For **filter**, each line is a probability, then the item.
With `--lines`, repeated log lines that differ only in numbers or ids are merged into
one pattern, followed by the matching line numbers:

```
0.99  src/db.ts
0.98  app.log:813  worker ERROR process killed: JavaScript heap out of memory
0.97  ×57  app.log:104  RAS KERNEL FATAL data TLB error interrupt
        also lines 115,121-130,…
? borderline (0.35–0.65) — check these yourself:
0.55  app/api/convert_safe.ts
— 340 scanned · 3 matched · 1 borderline · 4.1s · jev 90k tok ($0.0038) · ~88k Claude tokens not read
```

**search** lists files by role (implementation, caller, helper, test, fixture), each with its
selected declarations and their Jev value, then the selected code as source blocks:

```
0.97  src/utils/jwt/jwt.ts  implementation
      0.94  verify@96-189
      leads: decode@60-80
0.81  src/request.ts  other; locations only
Source block "src/utils/jwt/jwt.ts" lines 96-189:
…
End context.
```

`leads` are weaker matches (0.25–0.5) worth a look; `locations only` means the file matched
but no single declaration did. Read those with `offset`/`limit` if you need them.

**classify** prints the count per label, then the ids in each label. After that it lists
each low-confidence item with its runner-up label and its text:

```
bug 41 · feature 12 · question 7
[bug] T1 T4 T9 …
? low confidence — check these yourself:
?0.49  bug (or question)  T33  login button does nothing on Safari?
```

- `?` marks a borderline or low-confidence item. **Read those yourself.** In the
  benchmark, the false positives sat in this band. Treat everything else as a
  reliable shortlist.
- `~` after an item means it was truncated past `--max-chars` (default 60k chars),
  so Jev only saw the start.
- The footer shows cost and the estimated Claude tokens avoided. Mention the
  savings to the user when they're meaningful.
- Jev's verdicts make a **shortlist, not proof**. Open the survivors before you
  edit code, draw conclusions, or tell the user something is definitely absent.
  If a filter returns nothing you expected to find, rephrase the question or
  lower `--threshold` before concluding.

## Writing good questions

Jev reads questions **literally**. Its accuracy comes from how precise the question is.

- One judgment per question. Say "Does this file send email?", not "Does this file
  send email or handle billing?". Run two filters instead.
- Spell out the exact condition, including the boundary cases: "Does this line
  report a failure (ERROR, FATAL, crash, timeout). Not warnings about deprecation?"
- Use plain meaning, not jargon hops or double negatives.
- Give classify labels short descriptions with `--labels "bug:Something broken,feature:New behaviour request"`.
  Add a catch-all label such as `other` when nothing may fit.
- For a raw `ask` spec, put the content in `state` (JSON objects are fine) and refer
  to fields in backticks inside instructions, like `` `ticket.body` ``. Questions
  run in parallel and can't see each other's answers. See
  https://docs.typesafe.ai/api.md for the full schema.

## Patterns that pay off

- **Funnel:** `flash filter` over the whole repo, then Claude reads the 5 survivors
  instead of 300 files.
- **Log triage:** `flash filter ... --lines` over a 50k-line log, then Claude
  investigates only the failures.
- **Two-pass precision:** a cheap broad `filter`, then `rank` the survivors
  against the specific question.
- **Batch triage:** dump items to JSONL (issues, test output, grep hits),
  `flash classify`, then act per bucket.

Jev handles 1,200 requests/min. Flash retries rate limits (429/529) automatically.
