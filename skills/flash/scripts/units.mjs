// Split a source file into declaration units so `flash search` can judge and show one function or
// class at a time. Heuristic, zero-dependency: an indentation scan for Python, a column-0 keyword
// scan for JS/TS. Anything else, or a file where the scan finds nothing, falls back to text chunks.
// ponytail: no real parser. Upgrade path: shell out to `python3 -c "import ast…"` for .py if the
// benchmark shows the scan missing spans.

const TEXT_CHUNK = 3000;   // bytes per fallback text unit
const MAX_UNIT = 6000;     // units bigger than this are cut into text windows

const PY_DECL = /^(\s*)(?:async\s+)?(def|class)\s+([A-Za-z_]\w*)/;
const JS_DECL = /^(?:export\s+(?:default\s+)?)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(function\*?|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/;
const JS_EXT = /\.(m?[jt]sx?|cjs|cts|mts)$/i;

// A unit is { name, start, end } with 1-based inclusive line numbers.
export function splitUnits(text, file) {
  const lines = text.split(/\r?\n/);
  let units = null;
  if (/\.py$/i.test(file)) units = pythonUnits(lines);
  else if (JS_EXT.test(file)) units = jsUnits(lines);
  if (!units?.length) return textUnits(lines);
  return units.flatMap((u) => (unitSource(lines, u).length > MAX_UNIT ? textUnits(lines, u.start, u.end, u.name) : [u]));
}

export const unitSource = (lines, u) => lines.slice(u.start - 1, u.end).join('\n');

// Leading comments and decorators belong to the declaration below them.
function attachAbove(lines, start, isLead) {
  while (start > 1 && isLead(lines[start - 2])) start--;
  return start;
}

function pythonUnits(lines) {
  const units = [];
  const lead = (l) => /^\s*(@|#)/.test(l);
  const indent = (l) => l.match(/^\s*/)[0].length;
  const decls = [];
  lines.forEach((l, i) => { const m = PY_DECL.exec(l); if (m) decls.push({ i, depth: m[1].length, kind: m[2], name: m[3] }); });
  // A unit runs until the next line at the same or lower indentation that isn't blank or a comment.
  const endOf = (d) => {
    let last = d.i;
    for (let j = d.i + 1; j < lines.length; j++) {
      const l = lines[j];
      if (!l.trim() || /^\s*#/.test(l)) continue;
      if (indent(l) <= d.depth) break;
      last = j;
    }
    return last + 1;
  };
  const top = decls.filter((d) => d.depth === 0);
  for (const d of top) {
    const start = attachAbove(lines, d.i + 1, lead), end = endOf(d);
    if (d.kind === 'def') { units.push({ name: d.name, start, end }); continue; }
    // A class becomes a header unit (class line up to its first member) plus one unit per member.
    // Members are the defs and nested classes at the class body's own indentation.
    const inner = decls.filter((m) => m.i > d.i && m.i < end);
    const bodyDepth = Math.min(...inner.map((m) => m.depth));
    const methods = inner.filter((m) => m.depth === bodyDepth);
    if (!methods.length) { units.push({ name: d.name, start, end }); continue; }
    const firstStart = attachAbove(lines, methods[0].i + 1, lead);
    units.push({ name: `${d.name}.context`, start, end: firstStart - 1 });
    for (const m of methods) units.push({ name: `${d.name}.${m.name}`, start: attachAbove(lines, m.i + 1, lead), end: endOf(m) });
  }
  return units;
}

function jsUnits(lines) {
  const lead = (l) => /^\s*(\/\/|\/\*|\*|@)/.test(l);
  const starts = [];
  lines.forEach((l, i) => { const m = JS_DECL.exec(l); if (m) starts.push({ i, name: m[2] }); });
  return starts.map((d, k) => {
    const start = attachAbove(lines, d.i + 1, lead);
    const nextStart = k + 1 < starts.length ? attachAbove(lines, starts[k + 1].i + 1, lead) : lines.length + 1;
    let end = nextStart - 1;
    while (end > d.i + 1 && !lines[end - 1].trim()) end--;
    return { name: d.name, start, end };
  });
}

export function textUnits(lines, from = 1, to = lines.length, name = 'text', size = TEXT_CHUNK) {
  const out = [];
  let start = from, bytes = 0;
  for (let i = from; i <= to; i++) {
    bytes += lines[i - 1].length + 1;
    if (bytes >= size || i === to) { out.push({ name, start, end: i }); start = i + 1; bytes = 0; }
  }
  return out;
}

