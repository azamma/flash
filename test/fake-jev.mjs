// A local stand-in for Jev's decision endpoint. It answers every question from a simple rule:
// content containing the word MATCH is a "yes", a matching line or a top score. Tests can queue
// forced responses (a 429, a 401) and read back every request body that reached it.
import http from 'node:http';

const has = (v) => JSON.stringify(v ?? '').includes('MATCH');

// For a packed request the question points at `items.iN`; otherwise the whole state is the item.
function subject(state, q) {
  const m = /`items\.(i\d+)[.`]/.exec(q.instructions || '');
  return m ? state.items?.[m[1]] : state;
}

function answer(state, q) {
  const s = subject(state, q);
  if (q.type === 'noul') return { type: 'noul', noul: has(s) ? 0.95 : 0.05 };
  if (q.type === 'score') {
    const levels = Array.isArray(q.criteria) ? q.criteria : Object.keys(q.criteria || {});
    return { type: 'score', score: has(s) ? levels.length - 1 : 0, confidence: 0.9 };
  }
  const options = Array.isArray(q.criteria) ? q.criteria : Object.keys(q.criteria);
  const criteriaObj = Array.isArray(q.criteria) ? null : q.criteria;
  const text = JSON.stringify(s).toLowerCase();
  // find's `where` question: the options are line numbers of state.lines.
  // pick/web-style questions: criteria are objects keyed by option (e.g. by ref); pick the option
  // whose own criteria value contains MATCH, not just the first key.
  const pick = state.lines
    ? Object.keys(state.lines).find((n) => state.lines[n].includes('MATCH')) || 'none'
    : criteriaObj && options.some((o) => has(criteriaObj[o]))
    ? options.find((o) => has(criteriaObj[o]))
    : options.find((o) => text.includes(String(o).toLowerCase())) || options[0];
  const probabilities = Object.fromEntries(options.map((o) => [o, o === pick ? 0.9 : 0.1 / Math.max(1, options.length - 1)]));
  return { type: 'choice', choice: pick, confidence: 0.9, probabilities };
}

export async function startFakeJev() {
  const requests = [];
  const forced = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      requests.push({ auth: req.headers.authorization, body });
      const f = forced.shift();
      if (f) {
        res.writeHead(f.status, { 'content-type': 'application/json', ...f.headers });
        return res.end(JSON.stringify(f.body || { error: 'forced' }));
      }
      const answers = Object.fromEntries(Object.entries(body.questions || {}).map(([id, q]) => [id, answer(body.state, q)]));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ model: body.model, answers, usage: { input_tokens: 100 } }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    force: (...responses) => forced.push(...responses),
    reset: () => { requests.length = 0; forced.length = 0; },
    close: () => new Promise((r) => server.close(r)),
  };
}
