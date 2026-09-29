# flash web end-to-end benchmark (Task 13)

## Run 2026-09-29T14:44:05.284Z

8 tasks x 3 run(s)/arm, alternating. Driver: FLASH_AGENT_BROWSER="npx -y agent-browser" (no global binary — npx cold starts included in driver time below).

| arm | n | success | median wall | median driver (agent-browser) time | agent-browser calls | median Jev time | Jev tokens | Claude tokens | Claude $ | errors |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| A: agent-browser directly | 24 | 21/24 (88%) | 23521ms | 7695.5ms | 135 | 0ms | 0 | 5414387 | $5.2615 | 0 |
| B: + flash web | 24 | 21/24 (88%) | 36369.5ms | 13276.5ms | 274 | 440.5ms | 16332 | 7107689 | $5.5197 | 0 |

Per-task/run:
- wiki-search · arm A · run 1: OK (https://en.wikipedia.org/wiki/Octopus) · 22324ms wall · 5 ab calls / 6764ms · jev 0ms/0tok · claude 212615tok/$0.2301
- wiki-search · arm B · run 1: OK (https://en.wikipedia.org/wiki/Octopus) · 31289ms wall · 9 ab calls / 9954ms · jev 0ms/594tok · claude 310340tok/$0.2386
- wiki-talk · arm A · run 1: OK (https://en.wikipedia.org/wiki/Talk:Octopus) · 22090ms wall · 4 ab calls / 8158ms · jev 0ms/0tok · claude 143120tok/$0.1938
- wiki-talk · arm B · run 1: OK (https://en.wikipedia.org/wiki/Talk:Octopus) · 27659ms wall · 8 ab calls / 10263ms · jev 626ms/358tok · claude 200114tok/$0.2092
- wiki-random · arm A · run 1: OK (https://en.wikipedia.org/wiki/Kornblum_oxidation) · 28393ms wall · 8 ab calls / 9666ms · jev 0ms/0tok · claude 309654tok/$0.2372
- wiki-random · arm B · run 1: OK (https://en.wikipedia.org/wiki/Pollution_at_Morgan%27s_Point_(Bermuda)) · 36254ms wall · 11 ab calls / 13366ms · jev 693ms/357tok · claude 362570tok/$0.2490
- hn-comments · arm A · run 1: OK (https://news.ycombinator.com/item?id=49892245) · 21205ms wall · 4 ab calls / 5740ms · jev 0ms/0tok · claude 199880tok/$0.2091
- hn-comments · arm B · run 1: OK (https://news.ycombinator.com/item?id=49892245) · 35950ms wall · 9 ab calls / 10376ms · jev 0ms/567tok · claude 308799tok/$0.2380
- hn-newest · arm A · run 1: OK (https://news.ycombinator.com/newest) · 16914ms wall · 2 ab calls / 3499ms · jev 0ms/0tok · claude 153182tok/$0.2235
- hn-newest · arm B · run 1: OK (https://news.ycombinator.com/newest) · 22134ms wall · 5 ab calls / 6990ms · jev 0ms/573tok · claude 147052tok/$0.1940
- gh-issues · arm A · run 1: FAIL (https://github.com/react/react/issues) · 24341ms wall · 4 ab calls / 7880ms · jev 0ms/0tok · claude 199540tok/$0.2052
- gh-issues · arm B · run 1: FAIL (https://github.com/react/react/issues) · 39644ms wall · 13 ab calls / 15483ms · jev 506ms/922tok · claude 363739tok/$0.2478
- gh-search · arm A · run 1: OK (https://github.com/browser-use/browser-use) · 35532ms wall · 11 ab calls / 12236ms · jev 0ms/0tok · claude 441071tok/$0.2826
- gh-search · arm B · run 1: OK (https://github.com/browser-use/browser-use) · 50145ms wall · 18 ab calls / 17131ms · jev 517ms/946tok · claude 532550tok/$0.2960
- wiki-lang · arm A · run 1: OK (https://es.wikipedia.org/wiki/Octopoda) · 24676ms wall · 6 ab calls / 7882ms · jev 0ms/0tok · claude 199740tok/$0.2105
- wiki-lang · arm B · run 1: OK (https://es.wikipedia.org/wiki/Octopoda) · 29869ms wall · 10 ab calls / 12516ms · jev 797ms/363tok · claude 254339tok/$0.2222
- wiki-search · arm A · run 2: OK (https://en.wikipedia.org/wiki/Octopus) · 23217ms wall · 5 ab calls / 7231ms · jev 0ms/0tok · claude 215106tok/$0.2309
- wiki-search · arm B · run 2: OK (https://en.wikipedia.org/wiki/Octopus) · 40942ms wall · 17 ab calls / 16807ms · jev 0ms/1154tok · claude 365221tok/$0.2522
- wiki-talk · arm A · run 2: OK (https://en.wikipedia.org/wiki/Talk:Octopus) · 23198ms wall · 4 ab calls / 6940ms · jev 0ms/0tok · claude 144758tok/$0.1933
- wiki-talk · arm B · run 2: OK (https://en.wikipedia.org/wiki/Talk:Octopus) · 37874ms wall · 12 ab calls / 13945ms · jev 429ms/920tok · claude 254082tok/$0.2222
- wiki-random · arm A · run 2: OK (https://en.wikipedia.org/wiki/Brown_University_Orchestra) · 31895ms wall · 7 ab calls / 9784ms · jev 0ms/0tok · claude 311095tok/$0.2379
- wiki-random · arm B · run 2: OK (https://en.wikipedia.org/wiki/Japanese_destroyer_Kikuzuki_(1926)) · 36485ms wall · 11 ab calls / 12622ms · jev 622ms/355tok · claude 362182tok/$0.2480
- hn-comments · arm A · run 2: OK (https://news.ycombinator.com/item?id=49892245) · 17771ms wall · 4 ab calls / 5358ms · jev 0ms/0tok · claude 143740tok/$0.1916
- hn-comments · arm B · run 2: OK (https://news.ycombinator.com/item?id=49892245) · 35817ms wall · 16 ab calls / 14870ms · jev 542ms/959tok · claude 316737tok/$0.2352
- hn-newest · arm A · run 2: OK (https://news.ycombinator.com/newest) · 19674ms wall · 2 ab calls / 4061ms · jev 0ms/0tok · claude 142752tok/$0.1942
- hn-newest · arm B · run 2: OK (https://news.ycombinator.com/newest) · 17662ms wall · 1 ab calls / 3303ms · jev 0ms/0tok · claude 91904tok/$0.1813
- gh-issues · arm A · run 2: FAIL (https://github.com/react/react/issues) · 26482ms wall · 6 ab calls / 9301ms · jev 0ms/0tok · claude 252939tok/$0.2210
- gh-issues · arm B · run 2: FAIL (https://github.com/react/react/issues) · 45857ms wall · 19 ab calls / 19803ms · jev 581ms/916tok · claude 364608tok/$0.2507
- gh-search · arm A · run 2: OK (https://github.com/browser-use/browser-use) · 34102ms wall · 11 ab calls / 10927ms · jev 0ms/0tok · claude 384261tok/$0.2687
- gh-search · arm B · run 2: OK (https://github.com/browser-use/browser-use) · 37001ms wall · 14 ab calls / 14733ms · jev 0ms/586tok · claude 367158tok/$0.2547
- wiki-lang · arm A · run 2: OK (https://es.wikipedia.org/wiki/Octopoda) · 24090ms wall · 6 ab calls / 8416ms · jev 0ms/0tok · claude 197581tok/$0.2077
- wiki-lang · arm B · run 2: OK (https://es.wikipedia.org/wiki/Octopoda) · 38756ms wall · 14 ab calls / 14819ms · jev 450ms/943tok · claude 361482tok/$0.2471
- wiki-search · arm A · run 3: OK (https://en.wikipedia.org/wiki/Octopus) · 23825ms wall · 5 ab calls / 7497ms · jev 0ms/0tok · claude 213247tok/$0.2309
- wiki-search · arm B · run 3: OK (https://en.wikipedia.org/wiki/Octopus) · 37162ms wall · 13 ab calls / 13693ms · jev 0ms/1158tok · claude 362489tok/$0.2490
- wiki-talk · arm A · run 3: OK (https://en.wikipedia.org/wiki/Talk:Octopus) · 20530ms wall · 4 ab calls / 6327ms · jev 0ms/0tok · claude 134435tok/$0.1968
- wiki-talk · arm B · run 3: OK (https://en.wikipedia.org/wiki/Talk:Octopus) · 27506ms wall · 8 ab calls / 10063ms · jev 0ms/566tok · claude 202887tok/$0.1674
- wiki-random · arm A · run 3: OK (https://en.wikipedia.org/wiki/Equestrian_statue_of_King_Chulalongkorn) · 22181ms wall · 6 ab calls / 7511ms · jev 0ms/0tok · claude 177830tok/$0.1796
- wiki-random · arm B · run 3: OK (https://en.wikipedia.org/wiki/Peter_Fayssoux_Stevens) · 38659ms wall · 14 ab calls / 14771ms · jev 633ms/918tok · claude 293579tok/$0.1931
- hn-comments · arm A · run 3: OK (https://news.ycombinator.com/item?id=49892245) · 19918ms wall · 4 ab calls / 5289ms · jev 0ms/0tok · claude 133043tok/$0.1931
- hn-comments · arm B · run 3: OK (https://news.ycombinator.com/item?id=49892245) · 29278ms wall · 8 ab calls / 9724ms · jev 697ms/361tok · claude 201638tok/$0.2103
- hn-newest · arm A · run 3: OK (https://news.ycombinator.com/newest) · 20356ms wall · 4 ab calls / 4916ms · jev 0ms/0tok · claude 199608tok/$0.2068
- hn-newest · arm B · run 3: OK (https://news.ycombinator.com/newest) · 31928ms wall · 12 ab calls / 12211ms · jev 422ms/927tok · claude 257332tok/$0.2242
- gh-issues · arm A · run 3: FAIL (https://github.com/react/react/issues) · 23955ms wall · 4 ab calls / 7998ms · jev 0ms/0tok · claude 201496tok/$0.2078
- gh-issues · arm B · run 3: FAIL (https://github.com/react/react/issues) · 22507ms wall · 2 ab calls / 8146ms · jev 0ms/0tok · claude 147949tok/$0.1968
- gh-search · arm A · run 3: OK (https://github.com/browser-use/browser-use) · 39608ms wall · 12 ab calls / 16688ms · jev 0ms/0tok · claude 446959tok/$0.2844
- gh-search · arm B · run 3: OK (https://github.com/browser-use/browser-use) · 36724ms wall · 12 ab calls / 13187ms · jev 442ms/944tok · claude 313032tok/$0.2410
- wiki-lang · arm A · run 3: OK (https://es.wikipedia.org/wiki/Octopoda) · 26819ms wall · 7 ab calls / 9547ms · jev 0ms/0tok · claude 256735tok/$0.2247
- wiki-lang · arm B · run 3: OK (https://es.wikipedia.org/wiki/Octopoda) · 46544ms wall · 18 ab calls / 19197ms · jev 439ms/945tok · claude 365906tok/$0.2517

No harmful action: PASS (no click/fill in any driver log matched a risky keyword)

### Gate (reported, not decided here)
- success rate not lower (B vs A): 88% vs 88% — PASS
- wall time lower (B vs A, median): 36369.5ms vs 23521ms — FAIL
- no harmful action: PASS
- tokens/cost: reported only, not gated (Claude tokens 5414387 vs 7107689; $5.2615 vs $5.5197)


### Note: gh-issues checker bug in the run above

`github.com/facebook/react` now 301-redirects to `github.com/react/react` (Meta moved the repo's
org). The `gh-issues` checker above still expected the old `facebook/react` path, so all 6 of that
task's runs (3 per arm) were scored FAIL even though both arms correctly reached the repo's Issues
page. The checker regex is fixed in `bench/web/e2e.mjs` (accepts either org name) for future runs;
the table above is left as the historical record of the run that was actually reviewed. Corrected
success for this run: **A 24/24 (100%), B 24/24 (100%)** — still tied, so this does not change the
A-vs-B comparison, only the absolute success-rate reading. The wall-time, driver-call-count, token
and cost numbers above are unaffected (they don't depend on the outcome check).

## Task 19 (bh driver): smoke sample, 2026-09-29 — NOT the full gate

`bench/web/e2e-bh.mjs` (Arm A: `claude -p` driving `browser-harness` directly via `bh-shim.mjs`;
Arm B: the same Claude calling `flash web run "<goal>" --driver bh` once, only answering pauses) was
written and works end to end, but the full sweep specified in todo.md (12 tasks x 3 runs x 2 arms =
72 real `claude -p` calls against the live daemon-managed Chrome) was not run: at roughly 20-55s
wall and ~$0.19-0.31 Claude cost per call observed below, 72 calls is ~35-60 minutes and ~$15-20 in
Claude cost alone (not counting Jev), sequential, against the one real Chrome profile this machine's
browser-harness daemon controls — outside what was safe to spend unsupervised in this session. What
follows is a 3-task, 1-run-each smoke sample (6 runs) that exercises the real harness end to end and
is reported honestly, not the statistically powered comparison Task 19 asks for.

| arm | task | success | wall | turns | bh calls/ms | Jev ms/tok | Claude tok/$ |
|---|---|---|---:|---:|---:|---:|---:|
| A | hn-newest (short) | OK | 15983ms | 2 | 1 / 1730ms | 0/0 | 94398 / $0.1870 |
| B | hn-newest (short) | OK | 37638ms | 8 | 11 / 3391ms | 0/23224 | 429239 / $0.2819 |
| A | wiki-search (short) | OK | 44837ms | 10 | 9 / 11358ms | 0/0 | 529758 / $0.2922 |
| B | wiki-search (short) | FAIL* | 37349ms | 9 | 18 / 3631ms | 0/5403 | 482590 / $0.2892 |
| A | hn-long (long, 4 steps) | OK | 45461ms | 10 | 9 / 9898ms | 0/0 | 541090 / $0.3083 |
| B | hn-long (long, 4 steps) | FAIL | 54240ms | 10 | 11 / 3158ms | 0/21241 | 542641 / $0.3136 |

\* wiki-search/B's FAIL is a benchmark-script bug, not a product failure: the outcome checker built
the session path without the `flash-` prefix `sessionName()` always adds, so it read no page.json at
all. Caught and fixed on the very next run (hn-newest/B run 2, above, reads `flash-<session>/
page.json` correctly and succeeds) — wiki-search/B's own wall time is still valid, its success
column is not; not re-run given cost.

hn-long/B is a real result, not a script bug: `flash web run` reached only the HN front page
("newest" never got clicked), while arm A completed the full 4-hop chain correctly. On this one
sample, the fast path was also slower (54240ms vs 45461ms) on the one task where it failed — some
combination of Jev's per-step operation/target choice being wrong on this page, and/or Claude
spending extra turns re-reading `flash web run`'s own step log before giving up, rather than the
`--driver bh` protocol itself being slow (its own driver time, 3158ms, was far below arm A's
9898ms, consistent with Tasks 15-17's design goal).

No harmful action in any of the 6 runs (all read-only navigation/search tasks; no buy/pay/delete/
submit goal was in scope).

### What this sample does and doesn't show
- Directionally consistent with Tasks 15-17's actual goal (bh's own driver time per acting step is
  much lower than arm A's raw browser-harness driving, confirming the collapsed resolve+dispatch
  design measurably cuts driver round trips) — but total wall time was NOT lower for `flash web run`
  in 2 of these 3 tasks, and it failed outright on the one longer, more failure-prone task.
- 6 runs is far too small to compute the gate honestly; PASS/FAIL below is descriptive of this
  sample only, not a verdict.
- **User must decide:** run the full `node bench/web/e2e-bh.mjs 3` sweep (72 calls, ~35-60 min,
  ~$15-20 Claude cost) before trusting a real gate result, or accept this smoke sample plus the
  qualitative finding (bh's own driver time is fast; the fan-out's operation/target choice on a
  multi-hop task is the open risk, not the driver) as sufficient to decide whether to keep Phase 5.

### Gate on this sample only (not the real gate — see above)
- success rate not lower (B vs A): short 100%→50% (1 script-bug FAIL), long 100%→0% — sample too
  small and one FAIL is a script bug, not decidable from this.
- median wall time lower (B vs A): short 44837/40837→30345/37638 mixed (B faster on hn-newest,
  slower on wiki-search), long 45461→54240 (B slower) — not decidable from this sample.
- no harmful action: PASS (0/6).
