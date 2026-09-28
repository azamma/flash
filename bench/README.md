# Flash benchmark

Twelve situations a coding agent actually runs into. Each one is solved two ways, and both are scored against hidden ground truth.

- **Claude alone:** a Claude Sonnet subagent in Claude Code, using its normal Read/Grep/Glob tools. It may not write scripts. It works the way Claude does when it has no helper.
- **Claude + Flash:** the same task, run through `flash`. We score exactly what Claude would read back, and charge Flash for loading SKILL.md plus every command it issues.

## Reproduce

```bash
cd bench/data/raw
curl -sLO https://raw.githubusercontent.com/logpai/loghub/master/BGL/BGL_2k.log_structured.csv && mv BGL_2k.log_structured.csv bgl.csv
curl -sL -o lodash.js https://raw.githubusercontent.com/lodash/lodash/4.17.21/lodash.js
git clone --depth 400 https://github.com/honojs/hono.git
cd ../..
node build.mjs            # builds data/sNN + truth/sNN.json (HF datasets are fetched and cached)
node run-flash.mjs           # Flash side (needs a Jev key)
# Claude-alone side: run each prompt in prompts.md as a subagent, then record usage in results/baseline/usage.json
node score.mjs            # writes results/results.md + results.json
```

## How tokens are counted

- **Claude alone:** the subagent's measured token total, minus the **68.5k-token fixed floor**. We measured that floor with a control agent that reads one tiny file and writes one line. What remains is the tokens the task itself cost.
- **Flash:** SKILL.md (charged in full on every situation, as if each were a new session), plus each command, plus its full stdout, plus 40 tokens of tool-call wrapper per call. Token counts use chars ÷ 4.
- **Time:** wall-clock time for the agent run, against wall-clock time for the `flash` calls.

## Honest caveats

- The Claude-alone agents used Sonnet. A larger model would be more accurate and slower.
- For the huge-input situations (logs, repos, lodash), the baseline agent often greps first instead of reading everything. That's realistic, and it makes the baseline cheaper than "read it all".
- S12 is a **negative control**: a numeric comparison, which Jev is documented to be bad at. It's included to show where *not* to use Flash. Plain `awk` wins there for free.
- The synthetic sets (S02, S07, S08, S12) were written by the author. The real sets (S01, S03, S04, S05, S06, S09, S10, S11) come from public sources, listed in `truth/*.json`.

## S13: code retrieval (`find`, `find --context`, `search`)

A separate situation for the jevgrep-style features: four "where is X implemented?" questions on
honojs/hono `src` at a pinned commit. Truth is files plus line ranges (`truth/s13.json`). Each arm
is scored on **file recall** (truth files it names) and **range hit** (truth ranges it overlaps).

```bash
git clone https://github.com/honojs/hono && git -C hono checkout 18331a905e2415f7f73038357f2eec354123f7a6
node retrieval.mjs path/to/hono   # Flash arms, appended to results/retrieval-runs.jsonl
node retrieval.mjs --report       # writes results/retrieval.md
```

Results: [`results/retrieval.md`](results/retrieval.md). In short, `search` matched Claude alone
(0.88 file recall and range hit) with 43% fewer Claude tokens and in 60% of the time, for $0.13 of
Jev across the four questions. The saving comes from the hard question (JWT verification spread
over two files): Claude alone spent 30k tokens there. On questions whose answer sits in an
obviously named file (CORS, ETag), Claude's own Grep is as good and cheaper. `find` over a whole
repo is the wrong tool: it costs more Jev and misses files that `search` finds.

Accounting rules, adopted from jevgrep's eval:

- **The baseline is frozen.** `results/baseline/s13.json` was run once and is never rerun. The
  per-agent floor was measured in the same harness (a control agent that reads one file).
- **Every run is kept**, failures included, in `results/retrieval-runs.jsonl`. The report uses the
  latest successful run per question and arm, and says how many failed.
- **Jev cost is reported separately** from Claude tokens and never folded into them. A run whose
  cost can't be read counts as unknown, not zero.
- **Flash arms pay for SKILL.md** on every question, as in the main benchmark. Plain `find` also
  pays for a follow-up Read of ±20 lines around its top three hits.

