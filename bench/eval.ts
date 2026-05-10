/**
 * Offline benchmark — compares native JSON vs compact format token costs.
 * No API key needed. Uses js-tiktoken (o200k_base) for token counting.
 */

import { getEncoding } from 'js-tiktoken';

interface ToolCase {
  name: string;
  args: Record<string, unknown>;
}

interface ToolDef {
  name: string;
  description: string;
  properties: Record<string, { type: string; description?: string; enum?: string[] }>;
  required: string[];
}

// ── Tool catalog ──────────────────────────────────────────────

const tools: ToolDef[] = [
  { name: 'get_weather', description: 'Get current weather for a location', properties: { location: { type: 'string', description: 'City name' }, units: { type: 'string', enum: ['metric', 'imperial'] } }, required: ['location'] },
  { name: 'get_time', description: 'Get current time in a timezone', properties: { timezone: { type: 'string', description: 'IANA timezone' } }, required: ['timezone'] },
  { name: 'send_email', description: 'Send an email', properties: { to: { type: 'string', description: 'Recipient' }, subject: { type: 'string' }, body: { type: 'string' }, priority: { type: 'string', enum: ['low', 'normal', 'high'] } }, required: ['to', 'subject', 'body'] },
  { name: 'search_products', description: 'Search product catalog', properties: { query: { type: 'string' }, max_results: { type: 'integer' }, in_stock: { type: 'boolean' } }, required: ['query'] },
  { name: 'calculate', description: 'Evaluate a mathematical expression', properties: { expression: { type: 'string' } }, required: ['expression'] },
  { name: 'web_fetch', description: 'Fetch a URL', properties: { url: { type: 'string' }, method: { type: 'string', enum: ['GET', 'POST'] } }, required: ['url'] },
  { name: 'book_meeting', description: 'Book a calendar meeting', properties: { title: { type: 'string' }, date: { type: 'string' }, duration: { type: 'integer' }, attendees: { type: 'array', items: { type: 'string' } }, room: { type: 'string' } }, required: ['title', 'date', 'duration'] },
  { name: 'ask_db', description: 'Query a database', properties: { sql: { type: 'string' }, limit: { type: 'integer' } }, required: ['sql'] },
  { name: 'set_reminder', description: 'Set a reminder', properties: { message: { type: 'string' }, at_iso: { type: 'string' }, method: { type: 'string', enum: ['email', 'push', 'sms'] } }, required: ['message', 'at_iso'] },
];

// ── Test cases ────────────────────────────────────────────────

const singleCases: ToolCase[] = [
  { name: 'get_weather', args: { location: 'Austin', units: 'metric' } },
  { name: 'get_time', args: { timezone: 'America/New_York' } },
  { name: 'send_email', args: { to: 'a@b.com', subject: 'Hello', body: 'World', priority: 'high' } },
  { name: 'search_products', args: { query: 'wireless earbuds', max_results: 3, in_stock: true } },
  { name: 'calculate', args: { expression: '29.99 * 1.08' } },
  { name: 'web_fetch', args: { url: 'https://example.com', method: 'GET' } },
  { name: 'book_meeting', args: { title: 'Review', date: '2026-05-15', duration: 60, attendees: ['a@c.com'], room: 'A' } },
  { name: 'ask_db', args: { sql: 'SELECT count(*) FROM users WHERE active = true', limit: 50 } },
  { name: 'set_reminder', args: { message: 'Meeting with Alice', at_iso: '2026-05-02T14:00:00Z', method: 'email' } },
];

// ── Format builders ───────────────────────────────────────────

function nativeToolUse(name: string, args: Record<string, unknown>): string {
  return JSON.stringify({ type: 'tool_use', id: 'tu_bench', name, input: args });
}

function wireCall(name: string, args: Record<string, unknown>, tool: ToolDef): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === 'string') {
      parts.push(`${k}=${/[\s"=<>]/.test(v) ? JSON.stringify(v) : v}`);
    } else if (typeof v === 'boolean' || typeof v === 'number') {
      parts.push(`${k}=${v}`);
    } else if (Array.isArray(v)) {
      parts.push(`${k}=${JSON.stringify(v)}`);
    }
  }
  return `<call>${name} ${parts.join(' ')}</call>`;
}

function toolResultCall(name: string, args: Record<string, unknown>, tool: ToolDef): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === 'string') {
      parts.push(`${k}=${/[\s"=<>]/.test(v) ? JSON.stringify(v) : v}`);
    } else if (typeof v === 'boolean' || typeof v === 'number') {
      parts.push(`${k}=${v}`);
    } else if (Array.isArray(v)) {
      parts.push(`${k}=${JSON.stringify(v)}`);
    }
  }
  return `<tool_result name="${name}">${parts.join(' ')}</tool_result>`;
}

// ── Native tool definitions string ───────────────────────────

function buildNativeToolDefs(): string {
  return tools.map(t => JSON.stringify({
    name: t.name,
    description: t.description,
    input_schema: {
      type: 'object',
      properties: t.properties,
      required: t.required,
    },
  })).join('\n');
}

function buildCompactSignatures(): string {
  return tools.map(t => {
    const props = Object.entries(t.properties).map(([k, v]) => {
      const opt = t.required.includes(k) ? '' : '?';
      const type = v.enum ? v.enum.map(e => JSON.stringify(e)).join('|') : v.type;
      return `${k}${opt}:${type}`;
    });
    return `- ${t.name}: ${props.join(', ')} — ${t.description}`;
  }).join('\n');
}

// ── Token counter ─────────────────────────────────────────────

const enc = getEncoding('o200k_base');
const t = (s: string): number => enc.encode(s).length;

// ── Helpers ───────────────────────────────────────────────────

function fmt(n: number): string {
  return n.toLocaleString();
}

function pct(a: number, b: number): string {
  if (b === 0) return '—';
  return ((a / b - 1) * 100).toFixed(1) + '%';
}

// ── Run ───────────────────────────────────────────────────────

console.log('');
console.log('  ═══════════════════════════════════════════════════════════════');
console.log('  │   Offline Benchmark — Token Cost Comparison                │');
console.log('  │   No API key required                                      │');
console.log('  ═══════════════════════════════════════════════════════════════');
console.log('');

// Tool definitions
const nativeDefs = buildNativeToolDefs();
const compactSigs = buildCompactSignatures();
console.log('  Tool definitions (9 tools):');
console.log('  ┌───────────────────────┬──────────┬──────────┬──────────┐');
console.log('  │ Format                │ Tokens   │ Δ        │          │');
console.log('  ├───────────────────────┼──────────┼──────────┼──────────┤');
console.log('  │ Native JSON           │ ' + fmt(t(nativeDefs)).padStart(8) + ' │        — │          │');
console.log('  │ Compact signatures    │ ' + fmt(t(compactSigs)).padStart(8) + ' │ ' + pct(t(compactSigs), t(nativeDefs)).padStart(8) + ' │          │');
console.log('  └───────────────────────┴──────────┴──────────┴──────────┘');
console.log('');

// Single calls
console.log('  Per-call comparison:');
console.log('  ┌──────────────────────────┬──────────┬──────────┬──────────┬──────────┐');
console.log('  │ Tool                     │   Native │     Wire │ ToolResult│ Best     │');
console.log('  ├──────────────────────────┼──────────┼──────────┼──────────┼──────────┤');

let nativeTotal = 0, wireTotal = 0, trTotal = 0;

for (const c of singleCases) {
  const tool = tools.find(t => t.name === c.name)!;
  const n = t(nativeToolUse(c.name, c.args));
  const w = t(wireCall(c.name, c.args, tool));
  const tr = t(toolResultCall(c.name, c.args, tool));
  nativeTotal += n; wireTotal += w; trTotal += tr;
  const best = Math.min(n, w, tr);
  const bestLabel = best === n ? 'Native' : best === w ? 'Wire' : 'ToolRes';
  console.log(
    '  │ ' + c.name.padEnd(24) +
    ' │ ' + fmt(n).padStart(8) +
    ' │ ' + fmt(w).padStart(8) +
    ' │ ' + fmt(tr).padStart(8) +
    ' │ ' + bestLabel.padStart(8) + ' │',
  );
}

console.log('  ├──────────────────────────┼──────────┼──────────┼──────────┼──────────┤');
console.log(
  '  │ ' + 'TOTAL'.padEnd(24) +
  ' │ ' + fmt(nativeTotal).padStart(8) +
  ' │ ' + fmt(wireTotal).padStart(8) +
  ' │ ' + fmt(trTotal).padStart(8) +
  ' │          │',
);
console.log(
  '  │ ' + 'Savings vs native'.padEnd(24) +
  ' │        —' +
  ' │ ' + pct(wireTotal, nativeTotal).padStart(8) +
  ' │ ' + pct(trTotal, nativeTotal).padStart(8) +
  ' │          │',
);
console.log('  └──────────────────────────┴──────────┴──────────┴──────────┴──────────┘');

// Parallel calls
console.log('');
console.log('  Parallel calls (4 × get_time):');
const pNative = [0,1,2,3].map(() => t(nativeToolUse('get_time', { timezone: 'America/New_York' }))).reduce((a,b) => a+b, 0);
const pWire = t(`<call>getTime timezone="America/New_York"</call>\n<call>getTime timezone="Europe/London"</call>\n<call>getTime timezone="Asia/Tokyo"</call>\n<call>getTime timezone="Australia/Sydney"</call>`);
const pTR = t(`<tool_result name="getTime">timezone=America/New_York</tool_result>\n<tool_result name="getTime">timezone=Europe/London</tool_result>\n<tool_result name="getTime">timezone=Asia/Tokyo</tool_result>\n<tool_result name="getTime">timezone=Australia/Sydney</tool_result>`);
console.log('  ┌───────────────────────┬──────────┬──────────┐');
console.log('  │ Format                │ Tokens   │ Δ        │');
console.log('  ├───────────────────────┼──────────┼──────────┤');
console.log('  │ Native                │ ' + fmt(pNative).padStart(8) + ' │        — │');
console.log('  │ Wire                  │ ' + fmt(pWire).padStart(8) + ' │ ' + pct(pWire, pNative).padStart(8) + ' │');
console.log('  │ ToolResult            │ ' + fmt(pTR).padStart(8) + ' │ ' + pct(pTR, pNative).padStart(8) + ' │');
console.log('  └───────────────────────┴──────────┴──────────┘');

// Multi-turn simulation
console.log('');
console.log('  Multi-turn simulation (10 rounds, 3 calls each):');

function simTenTurns(callSize: number, resultSize: number): { history: number; output: number } {
  let history = 0;
  let totalInput = 0;
  let totalOutput = 0;
  for (let turn = 0; turn < 10; turn++) {
    const callsThisTurn = 3;
    if (turn === 0) {
      history = callsThisTurn * (callSize + resultSize);
      totalOutput = callsThisTurn * callSize;
    } else {
      totalInput += history;
      totalOutput += callsThisTurn * callSize;
      history += callsThisTurn * (callSize + resultSize);
    }
  }
  return { history: totalInput, output: totalOutput };
}

const avgNativeCall = Math.round(nativeTotal / singleCases.length);
const avgWireCall = Math.round(wireTotal / singleCases.length);
const avgTRCall = Math.round(trTotal / singleCases.length);
const avgResult = t(JSON.stringify({ type: 'tool_result', tool_use_id: 'tu_bench', content: 'result data' }));

const native = simTenTurns(avgNativeCall, avgResult);
const wire = simTenTurns(avgWireCall, avgResult);
const tr = simTenTurns(avgTRCall, avgResult);

console.log('  ┌───────────────────────┬────────────┬────────────┬────────────┐');
console.log('  │ Format                │ History in │ Output     │ Total      │');
console.log('  ├───────────────────────┼────────────┼────────────┼────────────┤');
const nativeTotal2 = native.history + native.output;
const wireTotal2 = wire.history + wire.output;
const trTotal2 = tr.history + tr.output;
console.log('  │ Native                │ ' + fmt(native.history).padStart(10) + ' │ ' + fmt(native.output).padStart(10) + ' │ ' + fmt(nativeTotal2).padStart(10) + ' │');
console.log('  │ Wire                  │ ' + fmt(wire.history).padStart(10) + ' │ ' + fmt(wire.output).padStart(10) + ' │ ' + fmt(wireTotal2).padStart(10) + ' │' + (wireTotal2 < nativeTotal2 ? ' ✅' : ' ❌'));
console.log('  │ ToolResult            │ ' + fmt(tr.history).padStart(10) + ' │ ' + fmt(tr.output).padStart(10) + ' │ ' + fmt(trTotal2).padStart(10) + ' │' + (trTotal2 < nativeTotal2 ? ' ✅' : ' ❌'));
console.log('  └───────────────────────┴────────────┴────────────┴────────────┘');
console.log('');

// Cost estimate
console.log('  Cost estimate (Sonnet $3/M input, $15/M output, 1000 runs/day):');
const nativeCost = nativeTotal2 * 1000 / 1_000_000 * 3 + native.output * 1000 / 1_000_000 * 12;
const wireCost = wireTotal2 * 1000 / 1_000_000 * 3 + wire.output * 1000 / 1_000_000 * 12;
const trCost = trTotal2 * 1000 / 1_000_000 * 3 + tr.output * 1000 / 1_000_000 * 12;
console.log('  ┌───────────────────────┬───────────┐');
console.log('  │ Format                │ Cost/day  │');
console.log('  ├───────────────────────┼───────────┤');
console.log('  │ Native                │  $' + nativeCost.toFixed(2).padStart(7) + ' │');
console.log('  │ Wire                  │  $' + wireCost.toFixed(2).padStart(7) + ' │' + (wireCost < nativeCost ? ' ✅' : ' ❌'));
console.log('  │ ToolResult            │  $' + trCost.toFixed(2).padStart(7) + ' │' + (trCost < nativeCost ? ' ✅' : ' ❌'));
console.log('  └───────────────────────┴───────────┘');
console.log('');
