// Scoring shared by run-flash.mjs (Flash side) and score.mjs (Claude-alone baseline).
export function prf(pred, truth, neutral = []) {
  const T = new Set(truth.map(String)), N = new Set(neutral.map(String));
  const P = [...new Set(pred.map(String))].filter((p) => !N.has(p));
  const tp = P.filter((p) => T.has(p)).length;
  const precision = P.length ? tp / P.length : 1, recall = T.size ? tp / T.size : 1;
  return { precision, recall, f1: precision + recall ? (2 * precision * recall) / (precision + recall) : 0, predicted: P.length, tp };
}

// cases: [[results, isHit], ...]. Share of queries whose first result, or any result, is a hit.
export function hitRate(cases) {
  const n = cases.length;
  return { hit1: cases.filter(([got, ok]) => ok(got[0])).length / n, hitK: cases.filter(([got, ok]) => got.some(ok)).length / n };
}
