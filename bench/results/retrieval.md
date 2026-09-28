# S13 code retrieval on honojs/hono @ 18331a9

| arm | file recall | range hit | Claude tokens (total) | Jev cost (total) | time (total) |
|---|---|---|---|---|---|
| Claude alone | 0.88 | 0.88 | 38.7k | — | 76s |
| find | 0.63 | 0.50 | 14.9k | $0.360 | 61s |
| find --context | 0.63 | 0.50 | 12.6k | $0.360 | 61s |
| search | 0.88 | 0.88 | 22.2k | $0.126 | 45s |

| question | Claude alone | find | find --context | search |
|---|---|---|---|---|
| jwt | files 1.00 · ranges 1.00 · 30.1k tok | files 0.50 · ranges 0.50 · 4.0k tok | files 0.50 · ranges 0.50 · 3.4k tok | files 1.00 · ranges 1.00 · 6.8k tok |
| cors | files 1.00 · ranges 1.00 · 2.8k tok | files 1.00 · ranges 1.00 · 3.8k tok | files 1.00 · ranges 1.00 · 3.0k tok | files 1.00 · ranges 1.00 · 4.3k tok |
| etag | files 1.00 · ranges 1.00 · 2.4k tok | files 1.00 · ranges 0.50 · 3.6k tok | files 1.00 · ranges 0.50 · 3.1k tok | files 1.00 · ranges 1.00 · 3.7k tok |
| basic | files 0.50 · ranges 0.50 · 3.3k tok | files 0.00 · ranges 0.00 · 3.5k tok | files 0.00 · ranges 0.00 · 3.1k tok | files 0.50 · ranges 0.50 · 7.3k tok |

Runs logged: 24 (0 failed, kept in retrieval-runs.jsonl). Claude-alone baseline frozen in baseline/s13.json; tokens are the agent total minus the 62.6k floor. Flash arms include 2.8k for SKILL.md per question.
