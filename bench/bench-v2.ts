/**
 * v2 Benchmark — input-side optimization (no format instruction).
 *
 * Tests that the new defaults (minifyToolDefinitions + rewriteHistory) save
 * input tokens without affecting accuracy or output token count.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-... bun run bench:v2
 *   ANTHROPIC_API_KEY=sk-... bun run bench:v2 --model claude-sonnet-4-5
 */

import Anthropic from '@anthropic-ai/sdk';
import { CompactAnthropic } from '../src/index.ts';
import { getEncoding } from 'js-tiktoken';

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error('Set ANTHROPIC_API_KEY to run benchmark');
  process.exit(1);
}

const modelArg = process.argv.find(a => a.startsWith('--model='));
const modelIdx = process.argv.indexOf('--model');
const MODEL = modelArg ? modelArg.split('=')[1] : (modelIdx >= 0 ? process.argv[modelIdx + 1] : 'claude-sonnet-4-5');

const PRICING: Record<string, [number, number]> = {
  'haiku': [1, 5], 'sonnet': [3, 15], 'opus': [5, 25],
};
const modelKey = MODEL.includes('haiku') ? 'haiku' : MODEL.includes('opus') ? 'opus' : 'sonnet';
const [IN_RATE, OUT_RATE] = PRICING[modelKey];

const tools = [
  { name: 'get_weather', description: 'Get the current weather for a location', input_schema: { type: 'object', properties: { location: { type: 'string', description: 'City name, e.g. Austin, TX' }, units: { type: 'string', enum: ['metric', 'imperial'], description: 'Temperature unit system' } }, required: ['location'] } },
  { name: 'search_products', description: 'Search a product catalog', input_schema: { type: 'object', properties: { query: { type: 'string', description: 'Search query string' }, max_results: { type: 'integer', description: 'Maximum number of results' }, in_stock: { type: 'boolean', description: 'Only show in-stock items' } }, required: ['query'] } },
  { name: 'calculate', description: 'Evaluate a mathematical expression', input_schema: { type: 'object', properties: { expression: { type: 'string', description: 'Expression to evaluate' } }, required: ['expression'] } },
  { name: 'send_email', description: 'Send an email to a recipient', input_schema: { type: 'object', properties: { to: { type: 'string', description: 'Recipient email address' }, subject: { type: 'string', description: 'Email subject line' }, body: { type: 'string', description: 'Email body content' }, priority: { type: 'string', enum: ['low', 'normal', 'high'], description: 'Priority level' } }, required: ['to', 'subject', 'body'] } },
];

const enc = getEncoding('o200k_base');

// Measure token savings from tool def minification
const nativeDefs = tools.map(t => JSON.stringify({
  name: t.name,
  description: t.description,
  input_schema: t.input_schema,
})).join('\n');
const nativeDefTokens = enc.encode(nativeDefs).length;

const minifiedTools = tools.map(t => {
  const schema = t.input_schema as Record<string, unknown>;
  const props = schema.properties as Record<string, Record<string, unknown>>;
  const minProps: Record<string, Record<string, unknown>> = {};
  for (const [k, v] of Object.entries(props)) {
    const m: Record<string, unknown> = {};
    if (v.type) m.type = v.type;
    if (v.enum) m.enum = v.enum;
    if (v.items) m.items = v.items;
    minProps[k] = m;
  }
  return JSON.stringify({
    name: t.name,
    description: t.description,
    input_schema: { type: 'object', properties: minProps, required: schema.required },
  });
}).join('\n');
const minDefTokens = enc.encode(minifiedTools).length;

// ── Tasks ──────────────────────────────────────────────────

interface TaskDef {
  diff: number;
  text: string;
  requires: string[];
  checks: ((calls: any[]) => boolean)[];
}

const tasks: TaskDef[] = [
  { diff: 0, text: 'What is the weather in Austin?', requires: ['get_weather'], checks: [(c: any[]) => c.some((x: any) => x.name === 'get_weather')] },
  { diff: 1, text: 'Search for wireless earbuds.', requires: ['search_products'], checks: [(c: any[]) => c.some((x: any) => x.name === 'search_products')] },
  { diff: 2, text: 'Calculate 29.99 * 1.08', requires: ['calculate'], checks: [(c: any[]) => c.some((x: any) => x.name === 'calculate')] },
  { diff: 3, text: 'What is the weather in Tokyo and London? Use metric units for both.', requires: ['get_weather', 'get_weather'], checks: [(c: any[]) => c.filter((x: any) => x.name === 'get_weather').length >= 2] },
  { diff: 4, text: 'Search for running shoes, max 5 results, in stock only.', requires: ['search_products'], checks: [(c: any[]) => { const s = c.find((x: any) => x.name === 'search_products'); return s && s.input && s.input.max_results === 5; }] },
  { diff: 5, text: 'Get the weather in Austin and Dallas, then calculate the average temperature.', requires: ['get_weather', 'get_weather', 'calculate'], checks: [(c: any[]) => c.filter((x: any) => x.name === 'get_weather').length >= 2 && c.filter((x: any) => x.name === 'calculate').length >= 1] },
  { diff: 6, text: 'Search for noise-canceling headphones, max 3 results. For the first result, calculate the price with 15% tax.', requires: ['search_products', 'calculate'], checks: [(c: any[]) => { const s = c.find((x: any) => x.name === 'search_products'); return s && s.input?.max_results === 3; }] },
  { diff: 7, text: 'What is the weather in New York, London, and Tokyo? Use imperial for US, metric for others. Then email to me@example.com.', requires: ['get_weather', 'get_weather', 'get_weather', 'send_email'], checks: [(c: any[]) => c.filter((x: any) => x.name === 'get_weather').length >= 3 && c.filter((x: any) => x.name === 'send_email').length >= 1] },
  { diff: 8, text: 'Search for "wireless mechanical keyboard" (in stock). Find the price of the first result. Calculate total with 8.25% tax and 10% coupon on pre-tax.', requires: ['search_products', 'calculate', 'calculate'], checks: [(c: any[]) => c.filter((x: any) => x.name === 'calculate').length >= 2] },
  { diff: 9, text: 'Get the weather in 5 cities across 3 continents. For cities below 60F, calculate the difference from 72F. Email report to report@example.com at high priority.', requires: ['get_weather', 'get_weather', 'get_weather', 'get_weather', 'get_weather', 'calculate', 'send_email'], checks: [(c: any[]) => c.filter((x: any) => x.name === 'get_weather').length >= 4 && c.filter((x: any) => x.name === 'send_email').length >= 1] },
  { diff: 10, text: 'Search for three product categories (electronics, sports, home). For each get first in-stock result. Calculate total with 7.5% tax and 20% discount. Get weather in top 3 cities. Email report.', requires: ['search_products', 'search_products', 'search_products', 'calculate', 'calculate', 'get_weather', 'send_email'], checks: [(c: any[]) => c.filter((x: any) => x.name === 'search_products').length >= 2 && c.filter((x: any) => x.name === 'calculate').length >= 1 && c.filter((x: any) => x.name === 'send_email').length >= 1] },
];

// ── Run ──────────────────────────────────────────────────

async function runBenchmark() {
  const rawClient = new Anthropic({ apiKey });
  const compactClient = new CompactAnthropic({ apiKey });

  async function runOne(client: Anthropic | CompactAnthropic, text: string, task: TaskDef, label: string) {
    const start = Date.now();
    try {
      const response = await client.messages.create({
        model: MODEL,
        max_tokens: 2048,
        tools: tools as any,
        messages: [{ role: 'user', content: text }],
      } as any);

      const calledTools = response.content.filter((b: any) => b.type === 'tool_use');
      const names = calledTools.map((b: any) => b.name);
      const inputs = calledTools.map((b: any) => b.input);
      return {
        label, diff: task.diff, ok: true,
        in: response.usage.input_tokens,
        out: response.usage.output_tokens,
        calls: calledTools.length, names,
        acc: task.requires.every(t => names.includes(t)),
        pass: task.checks.every(c => c(inputs)),
        ms: Date.now() - start,
      };
    } catch (err) {
      return { label, diff: task.diff, ok: false, in: 0, out: 0, calls: 0, names: [], acc: false, pass: false, ms: Date.now() - start, error: (err as Error).message };
    }
  }

  // ── Header ──────────────────────────────────────────────

  console.log('');
  console.log('  ' + '='.repeat(58));
  console.log('    Compact Tool Calling — v2 Benchmark (input-side)');
  console.log('    Model: ' + MODEL);
  console.log('    11 prompts x 2 modes = ' + (tasks.length * 2) + ' API calls');
  console.log('    No format instruction — input-only optimization');
  console.log('    Pricing: $' + IN_RATE + '/M in, $' + OUT_RATE + '/M out');
  console.log('  ' + '='.repeat(58));
  console.log('');

  // ── Tool definition savings ────────────────────────────

  const defSavings = nativeDefTokens - minDefTokens;
  console.log('  Tool definitions (' + tools.length + ' tools):');
  console.log('    Native: ' + nativeDefTokens + ' tok  Minified: ' + minDefTokens + ' tok  (save ' + defSavings + ' tok, ' + ((1 - minDefTokens / nativeDefTokens) * 100).toFixed(1) + '%)');
  console.log('    Cached once per cache TTL');
  console.log('');

  // ── Per-prompt runs ────────────────────────────────────

  const results: any[] = [];
  const summary = { native: { out: 0, in: 0, acc: 0 }, compact: { out: 0, in: 0, acc: 0 } };

  for (const task of tasks) {
    process.stdout.write('  [' + String(task.diff).padStart(2) + '] ' + task.text.slice(0, 53).padEnd(55));

    for (const mode of ['native', 'compact'] as const) {
      const client = mode === 'native' ? rawClient : compactClient;
      const r = await runOne(client, task.text, task);
      results.push(r);
      summary[mode].out += r.out;
      summary[mode].in += r.in;
      if (r.acc) summary[mode].acc++;
      const icon = r.acc ? 'ok' : 'FAIL';
      const tok = r.ok ? String(r.out) : 'ERR';
      process.stdout.write(mode === 'native' ? 'N:' + tok + icon + ' ' : 'C:' + tok + icon + ' ');
    }
    process.stdout.write('\n');
  }

  // ── Summary table ──────────────────────────────────────

  const s = summary;
  const fmt = (n: number) => n.toLocaleString();
  const cost = (out: number, inp: number) => (out / 1e6 * OUT_RATE + inp / 1e6 * IN_RATE);
  const nativeC = cost(s.native.out, s.native.in);
  const compactC = cost(s.compact.out, s.compact.in);

  // Estimate 10-turn cost
  const perTurnInSavings = tasks.length > 0 ? Math.max(0, s.native.in - s.compact.in) / tasks.length : 0;
  const native10 = cost(s.native.out * 10, s.native.in * 10);
  const compact10 = cost(s.compact.out * 10, s.native.in * 10 - perTurnInSavings * 10);

  console.log('');
  console.log('  ' + '='.repeat(58));
  console.log('  Results - ' + MODEL);
  console.log('  ' + '='.repeat(58));
  console.log('');

  // Show errors from either mode
  const firstNativeError = results.find((r: any) => r.error && r.label === 'native');
  const firstCompactError = results.find((r: any) => r.error && r.label === 'compact');
  if (firstNativeError && s.native.out === 0) {
    console.log('  ERROR: All native calls failed. First error:');
    console.log('    ' + firstNativeError.error);
    console.log('');
  }
  if (firstCompactError && s.compact.out === 0) {
    console.log('  ERROR: All compact calls failed. First error:');
    console.log('    ' + firstCompactError.error);
    console.log('');
  }
  // Print individual errors
  const errors = results.filter((r: any) => r.error);
  for (const e of errors) {
    console.log('  [' + e.label + ':' + e.diff + '] ' + e.error);
  }

  const inSave = s.native.in - s.compact.in;
  const inPct = s.native.in > 0 ? ((1 - s.compact.in / s.native.in) * 100).toFixed(1) : '0.0';
  const outDiff = s.compact.out - s.native.out;
  const outPct = s.native.out > 0 ? ((s.compact.out / s.native.out - 1) * 100).toFixed(1) : '-';

  console.log('  ' + '-'.repeat(52));
  console.log('  ' + '  Metric'.padEnd(20) + 'Native'.padEnd(16) + 'Compact');
  console.log('  ' + '-'.repeat(52));
  console.log('  ' + '  Output tokens'.padEnd(20) + fmt(s.native.out).padStart(8) + '      ' + fmt(s.compact.out).padStart(8) + ' (' + outPct + '%)');
  console.log('  ' + '  Input tokens'.padEnd(20) + fmt(s.native.in).padStart(8) + '      ' + fmt(s.compact.in).padStart(8) + ' (' + inPct + '%' + (inSave > 0 ? ' save)' : ')'));
  console.log('  ' + '  Accuracy'.padEnd(20) + (s.native.acc + '/' + tasks.length).padStart(8) + '      ' + (s.compact.acc + '/' + tasks.length).padStart(8));
  console.log('  ' + '-'.repeat(52));
  console.log('  ' + '  Cost per call'.padEnd(20) + '$' + (nativeC * 1000).toFixed(3).padStart(7) + '    ' + '$' + (compactC * 1000).toFixed(3).padStart(7) + (compactC < nativeC ? ' ok' : outDiff > 0 ? ' worse' : ''));
  console.log('  ' + '  Cost (10 calls)'.padEnd(20) + '$' + (native10 * 1000).toFixed(3).padStart(7) + '    ' + '$' + (compact10 * 1000).toFixed(3).padStart(7) + (compact10 < native10 ? ' ok' : ' worse'));
  console.log('  ' + '-'.repeat(52));
  console.log('');

  // ── Multi-turn estimate ──────────────────────────────

  let nativeTotal3 = 0, compactTotal3 = 0, savings3 = '0.0';

  const multiTurnResults = results.filter((r: any) => r.calls > 0);
  if (multiTurnResults.length > 0) {
    const nativeResults = multiTurnResults.filter((r: any) => r.label === 'native');
    const compactResults = multiTurnResults.filter((r: any) => r.label === 'compact');
    const avgNativeIn = nativeResults.length > 0 ? nativeResults.reduce((a: number, r: any) => a + r.in, 0) / nativeResults.length : 0;
    const avgCompactIn = compactResults.length > 0 ? compactResults.reduce((a: number, r: any) => a + r.in, 0) / compactResults.length : 0;
    const avgOut = nativeResults.length > 0 ? nativeResults.reduce((a: number, r: any) => a + r.out, 0) / nativeResults.length : 0;

    if (avgOut > 0) {
      console.log('  Multi-turn estimate (3 turns, ' + multiTurnResults.length + ' prompts with tool calls):');
      console.log('  ' + '-'.repeat(52));

      const toolResultSize = enc.encode(JSON.stringify({ type: 'tool_result', tool_use_id: 'tu_x', content: '42' })).length;
      let nativeHistoryAcc = 0, compactHistoryAcc = 0;

      for (let turn = 0; turn < 3; turn++) {
        const currentPrompt = enc.encode('What is the next step?').length;
        const nativeInput = nativeHistoryAcc + currentPrompt + avgNativeIn;
        const compactInput = compactHistoryAcc + currentPrompt + avgCompactIn;

        nativeTotal3 += nativeInput + avgOut;
        compactTotal3 += compactInput + avgOut;

        nativeHistoryAcc += Math.round(avgOut) + toolResultSize;
        compactHistoryAcc += Math.round(avgOut) + toolResultSize;
      }

      const nativeCost3 = cost(nativeTotal3, nativeTotal3 - avgOut * 3);
      const compactCost3 = cost(compactTotal3, compactTotal3 - avgOut * 3);
      savings3 = ((1 - compactCost3 / nativeCost3) * 100).toFixed(1);

      console.log('    Native:  ' + nativeTotal3 + ' total tok, $' + (nativeCost3 * 1000).toFixed(3));
      console.log('    Compact: ' + compactTotal3 + ' total tok, $' + (compactCost3 * 1000).toFixed(3) + ' (' + savings3 + '%' + (Number(savings3) > 0 ? ' ok' : '') + ')');
      console.log('');
    }
  }

  // ── Save ────────────────────────────────────────────────

  const url = new URL('../results/', import.meta.url);
  const fs = await import('fs');
  fs.mkdirSync(url.pathname, { recursive: true });
  const file = url.pathname + 'v2-' + MODEL.replace(/[^a-z0-9.-]/gi, '_') + '-' + Date.now() + '.json';
  fs.writeFileSync(file, JSON.stringify({
    model: MODEL, version: 'v2', timestamp: new Date().toISOString(),
    toolDefs: { native: nativeDefTokens, minified: minDefTokens, savings: defSavings },
    native: s.native, compact: s.compact,
    nativeCost: nativeC, compactCost: compactC,
    multiTurn3: { native: nativeTotal3, compact: compactTotal3, savings: savings3 },
  }, null, 2));
  console.log('  Saved: ' + file + '\n');
}

await runBenchmark();
