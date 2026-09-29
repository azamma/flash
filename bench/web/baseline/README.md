# Claude-alone baseline (frozen)

Three independent runs of a fresh `general-purpose` subagent (no memory of each other, no memory
of how `dataset.json`'s intents were written, no access to `gold.json`), each given only:

- `dataset.json` (id, slug, intent, injected — no gold)
- the 42 snapshot files under `../snapshots/`

and asked to decide, using only Read/Grep/Bash (no `flash`, no browser), which single ref it would
click for each of the 43 intents. This simulates "Claude alone" the way `bench/README.md`'s main
benchmark does for its own situations — one subagent per run, not one subagent per item.

Produced once, for Task 7 of `plans/flash-web/todo.md`; frozen from here on. `run.mjs` only reads
these three files, it never regenerates them.

## Measured cost (real, from each run's completion event — not estimated)

| run | subagent tokens | tool uses | wall time |
|---|---:|---:|---:|
| 1 | 125,733 | 46 | 302.5s |
| 2 | 101,285 | 24 | 176.2s |
| 3 | 113,649 | 41 | 251.3s |

Using `bench/README.md`'s existing 68.5k fixed-floor measurement (a control agent that reads one
tiny file and writes one line) rather than re-measuring a new floor specific to this harness — the
tool surface (Read/Grep/Bash) is the same Claude Code environment, so the floor should transfer
reasonably, but it wasn't re-verified for this specific task shape. Noted as a simplifying
assumption, not a re-derived number.

| run | tokens over the floor |
|---|---:|
| 1 | 57,233 |
| 2 | 32,785 |
| 3 | 45,149 |

## Honest caveats

- Entries 14 (`github-vscode`, "fork the repository") and 27 (`httpbin-form`, "open the topping
  dropdown") got `chosen: null` in all three runs — the subagent correctly found no Fork link in
  vscode's captured refs and no dropdown among httpbin's checkbox toppings. `gold.json` agrees
  (empty `gold` array for both): these two entries score as unscored (no gold to compare against)
  rather than as a miss for either arm.
- Entries 36-37 (the hotel fixture) show `chosen: "e27128"` / `"e27124"` in runs 1 and 3 — neither
  ref actually exists on that page (the real refs are e27174-e27191). This looks like the subagent
  transcribing a ref id from memory/adjacent context rather than re-reading it, which is a
  realistic failure mode for an unaided agent skimming a large combined ref space across many
  files, not a labeling bug. It's left as-is: a legitimate baseline error, scored as a miss.
- The baseline has no notion of runner-up candidates (it names one ref, not a ranked list), so its
  top-3 accuracy in `RESULTS.md` is identical to its top-1 by construction — included only so the
  table has the same columns as the Flash arm, not as an independent measurement.
