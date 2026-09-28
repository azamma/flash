| # | Situation | Metric | Claude alone | Flash | Claude tokens (alone → Flash) | Token cut | Time (alone → Flash) | Speed-up | Jev cost |
|---|---|---|---|---|---|---|---|---|---|
| 01 | Real log triage | F1 | 54% | 23% | 84.4k → 12.5k | **85%** | 105s → 43.5s | 2.4× | $0.0325 |
| 02 | Needles in a noisy service log | F1 | 100% | 100% | 53.5k → 2.5k | **95%** | 56s → 64.2s | 0.9× | $0.0436 |
| 03 | Support ticket routing | accuracy | 100% | 99% | 15.0k → 2.7k | **82%** | 60s → 5.7s | 10.5× | $0.0032 |
| 04 | Spam filtering | F1 | 97% | 92% | 20.4k → 4.3k | **79%** | 61s → 7.6s | 8.0× | $0.0042 |
| 05 | Review sentiment | accuracy | 97% | 96% | 19.5k → 3.0k | **85%** | 85s → 5.6s | 15.3× | $0.0028 |
| 06 | Codebase discovery | F1 | 100% | 100% | 26.4k → 2.4k | **91%** | 43s → 5.7s | 7.6× | $0.0127 |
| 07 | Security review shortlist | F1 | 100% | 89% | 9.5k → 2.5k | **74%** | 48s → 2.6s | 18.7× | $0.0006 |
| 08 | CI failure triage | accuracy | 100% | 100% | 9.1k → 2.5k | **72%** | 30s → 3.0s | 10.2× | $0.0015 |
| 09 | Semantic search in a huge file | hit@5 | 100% | 100% | 9.0k → 4.1k | **55%** | 39s → 38.5s | 1.0× | $0.2129 |
| 10 | Relevance ranking | hit@3 | 100% | 100% | 39.4k → 3.4k | **91%** | 60s → 55.5s | 1.1× | $0.1338 |
| 11 | Commit classification | accuracy | 83% | 76% | 17.5k → 3.2k | **82%** | 106s → 5.2s | 20.4× | $0.0033 |
| 12 | Numeric threshold stress test | F1 | 100% | 100% | 10.2k → 2.4k | **76%** | 19s → 5.6s | 3.4× | $0.0029 |

**All 12 situations:** 86% fewer Claude tokens overall (median 82%), 2.9× faster, avg quality 90% vs 94% for Claude alone, total Jev spend $0.454.
