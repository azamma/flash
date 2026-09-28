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
