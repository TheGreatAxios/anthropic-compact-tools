/**
 * Live benchmark — measures actual token savings AND accuracy.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-... bun run bench:live
 *   ANTHROPIC_API_KEY=sk-... bun run bench:live --model claude-opus-4-7
 *   bun run bench:live --compare
 *   bun run bench:live --compare --save
 */

import Anthropic from '@anthropic-ai/sdk';
import { transformRequest, transformResponse } from '../src/transform.ts';
import type { MessagesCreateParams, MessageResponse } from '../src/types.ts';

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey && !process.argv.includes('--compare')) {
  console.error('Set ANTHROPIC_API_KEY to run benchmark, or use --compare');
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

const tools: MessagesCreateParams['tools'] = [
  { name: 'get_weather', description: 'Get the current weather for a location', input_schema: { type: 'object', properties: { location: { type: 'string' }, units: { type: 'string', enum: ['metric', 'imperial'] } }, required: ['location'] } },
  { name: 'search_products', description: 'Search a product catalog', input_schema: { type: 'object', properties: { query: { type: 'string' }, max_results: { type: 'integer' }, in_stock: { type: 'boolean' } }, required: ['query'] } },
  { name: 'calculate', description: 'Evaluate a mathematical expression', input_schema: { type: 'object', properties: { expression: { type: 'string' } }, required: ['expression'] } },
  { name: 'send_email', description: 'Send an email to a recipient', input_schema: { type: 'object', properties: { to: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' }, priority: { type: 'string', enum: ['low', 'normal', 'high'] } }, required: ['to', 'subject', 'body'] } },
];

interface TaskDef { diff: number; text: string; requires: string[]; checks: ((calls: any[]) => boolean)[] }

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
  { diff: 9, text: 'Get the weather in 5 cities across 3 continents. For cities below 60\u00b0F, calculate the difference from 72\u00b0F. Email report to report@example.com at high priority.', requires: ['get_weather', 'get_weather', 'get_weather', 'get_weather', 'get_weather', 'calculate', 'send_email'], checks: [(c: any[]) => c.filter((x: any) => x.name === 'get_weather').length >= 4 && c.filter((x: any) => x.name === 'send_email').length >= 1] },
  { diff: 10, text: 'Search for three product categories (electronics, sports, home). For each get first in-stock result. Calculate total with 7.5% tax and 20% discount. Get weather in top 3 cities. Email report.', requires: ['search_products', 'search_products', 'search_products', 'calculate', 'calculate', 'get_weather', 'send_email'], checks: [(c: any[]) => c.filter((x: any) => x.name === 'search_products').length >= 2 && c.filter((x: any) => x.name === 'calculate').length >= 1 && c.filter((x: any) => x.name === 'send_email').length >= 1] },
];

// ── Run ──────────────────────────────────────────────────

async function runBenchmark() {
  const client = new Anthropic({ apiKey });

  async function runOne(mode: string, text: string, task: TaskDef) {
    const start = Date.now();
    try {
      const base: MessagesCreateParams = { model: MODEL, max_tokens: 2048, tools, messages: [{ role: 'user', content: text }] };
      let response: MessageResponse;

      if (mode === 'native') {
        response = await client.messages.create(base);
      } else {
        const opts = { syntax: mode as 'wire' | 'tool_result', placement: 'first_user' as const, rewriteHistory: false, minifyToolDefinitions: false };
        const { params: transformed, plans } = transformRequest(base, opts);
        response = transformResponse(await client.messages.create(transformed as any), plans);
      }

      const calledTools = response.content.filter((b: any) => b.type === 'tool_use');
      const names = calledTools.map((b: any) => b.name);
      const inputs = calledTools.map((b: any) => b.input);
      return {
        mode, diff: task.diff, ok: true,
        in: response.usage.input_tokens,
        out: response.usage.output_tokens,
        calls: calledTools.length, names,
        acc: task.requires.every(t => names.includes(t)),
        pass: task.checks.every(c => c(inputs)),
        ms: Date.now() - start,
      };
    } catch (err) {
      return { mode, diff: task.diff, ok: false, in: 0, out: 0, calls: 0, names: [], acc: false, pass: false, ms: Date.now() - start, error: (err as Error).message };
    }
  }

  // Header
  console.log('');
  console.log('  ' + '='.repeat(58));
  console.log('    Compact Tool Calling — Live Benchmark');
  console.log('    Model: ' + MODEL + '  |  ' + tasks.length + ' prompts x 3 modes = ' + (tasks.length * 3) + ' calls');
  console.log('    Pricing: $' + IN_RATE + '/M in, $' + OUT_RATE + '/M out');
  console.log('  ' + '='.repeat(58));
  console.log('');

  const results: any[] = [];
  let summary: any = { native: { out: 0, in: 0, acc: 0 }, wire: { out: 0, in: 0, acc: 0 }, tool_result: { out: 0, in: 0, acc: 0 } };

  for (const task of tasks) {
    process.stdout.write('  [' + String(task.diff).padStart(2) + '] ' + task.text.slice(0, 53).padEnd(55));

    for (const mode of ['native', 'wire', 'tool_result'] as const) {
      const r = await runOne(mode, task.text, task);
      results.push(r);
      summary[mode].out += r.out;
      summary[mode].in += r.in;
      if (r.acc) summary[mode].acc++;
      const label = mode === 'native' ? 'N' : mode === 'wire' ? 'W' : 'TR';
      process.stdout.write(label + ':' + String(r.out).padStart(4) + (r.acc ? '✓' : '✗') + (r.error ? '!' : ' ') + ' ');
    }
    process.stdout.write('\n');
  }

  // ── Summary table ──────────────────────────────────────

  const s = summary;
  const fmt = (n: number) => n.toLocaleString();
  const pct = (a: number, b: number) => a === 0 ? '—' : ((1 - a / b) * 100).toFixed(1) + '%';
  const cost = (out: number, inp: number) => (out / 1e6 * OUT_RATE + inp / 1e6 * IN_RATE);

  const nativeC = cost(s.native.out, s.native.in);
  const wireC = cost(s.wire.out, s.wire.in);
  const trC = cost(s.tool_result.out, s.tool_result.in);

  // 10-turn estimate: input overhead paid once, output savings per turn
  const overhead = Math.max(0, s.wire.in - s.native.in);
  const native10 = cost(s.native.out * 10, s.native.in * 10);
  const wire10 = cost(s.wire.out * 10, s.native.in + overhead);
  const tr10 = cost(s.tool_result.out * 10, s.native.in + Math.max(0, s.tool_result.in - s.native.in));

  const breakeven = (savings: number) => {
    if (savings <= 0) return 'never';
    const t = Math.ceil(overhead / (savings / 11));
    return t + ' turn' + (t !== 1 ? 's' : '');
  };

  console.log('');
  console.log('  ' + '='.repeat(58));
  console.log('  Results — ' + MODEL);
  console.log('  ' + '='.repeat(58));
  console.log('');
  console.log('  ' + '─'.repeat(52));
  console.log('  ' + '  Metric'.padEnd(20) + 'Native'.padEnd(16) + 'Wire'.padEnd(16) + 'ToolResult');
  console.log('  ' + '─'.repeat(52));

  // Show first error if all calls failed
  const firstError = results.find((r: any) => r.error);
  if (firstError && s.native.out === 0) {
    console.log('  \n  ⚠ All calls returned 0 tokens. First error:');
    console.log('    ' + firstError.error);
    console.log('  \n  Tip: Verify the model name is correct.');
    console.log('       Valid: claude-sonnet-4-5, claude-opus-4-7, claude-haiku-4-5\n');
    console.log('  ');
  }

  console.log('  ' + '  Output tokens'.padEnd(20) + fmt(s.native.out).padStart(8) + ' ' + pct(s.wire.out, s.native.out).padStart(7) + fmt(s.wire.out).padStart(8) + ' ' + pct(s.tool_result.out, s.native.out).padStart(7));
  console.log('  ' + '  Input tokens'.padEnd(20) + fmt(s.native.in).padStart(8) + ' ' + ('+' + ((s.wire.in / s.native.in - 1) * 100).toFixed(1) + '%').padStart(7) + fmt(s.wire.in).padStart(8) + ' ' + ('+' + ((s.tool_result.in / s.native.in - 1) * 100).toFixed(1) + '%').padStart(7));
  console.log('  ' + '  Accuracy'.padEnd(20) + (s.native.acc + '/' + tasks.length).padStart(8) + (s.wire.acc + '/' + tasks.length).padStart(8) + (s.tool_result.acc + '/' + tasks.length).padStart(16));
  console.log('  ' + '─'.repeat(52));
  console.log('  ' + '  Cost per call'.padEnd(20) + '$' + (nativeC * 1000).toFixed(2).padStart(5) + '  ' + '$' + (wireC * 1000).toFixed(2).padStart(5) + (wireC < nativeC ? ' ✅' : ' ❌') + '  ' + '$' + (trC * 1000).toFixed(2).padStart(5) + (trC < nativeC ? ' ✅' : ' ❌'));
  console.log('  ' + '  Cost (10 calls)'.padEnd(20) + '$' + (native10 * 1000).toFixed(2).padStart(5) + '  ' + '$' + (wire10 * 1000).toFixed(2).padStart(5) + (wire10 < native10 ? ' ✅' : ' ❌') + '  ' + '$' + (tr10 * 1000).toFixed(2).padStart(5) + (tr10 < native10 ? ' ✅' : ' ❌'));
  const wireSav = (s.native.out - s.wire.out);
  const trSav = (s.native.out - s.tool_result.out);
  console.log('  ' + '  Breakeven'.padEnd(20) + '—'.padStart(8) + '  ' + breakeven(wireSav).padStart(9) + '  ' + breakeven(trSav).padStart(9));
  console.log('  ' + '─'.repeat(52));
  console.log('  ' + '  Verdict'.padEnd(20) + '—'.padStart(8) + '  ' + (wire10 < native10 && s.wire.acc >= s.native.acc ? '✅ Use wire' : '❌ Not worth').padStart(12) + '  ' + (tr10 < native10 && s.tool_result.acc >= s.native.acc ? '✅ Use TR' : '❌ Not worth').padStart(12));
  console.log('  ' + '─'.repeat(52));
  console.log('');

  // Save
  const perPrompt = tasks.map(task => {
    const n = results.find((r: any) => r.mode === 'native' && r.diff === task.diff);
    const w = results.find((r: any) => r.mode === 'wire' && r.diff === task.diff);
    const t = results.find((r: any) => r.mode === 'tool_result' && r.diff === task.diff);
    return { diff: task.diff, native: n.out, wire: w.out, tr: t.out, nOk: n.acc, wOk: w.acc, tOk: t.acc };
  });

  const url = new URL('../results/', import.meta.url);
  const fs = await import('fs');
  fs.mkdirSync(url.pathname, { recursive: true });
  const file = url.pathname + MODEL.replace(/[^a-z0-9.-]/gi, '_') + '-' + Date.now() + '.json';
  fs.writeFileSync(file, JSON.stringify({
    model: MODEL, timestamp: new Date().toISOString(),
    native: s.native, wire: s.wire, tr: s.tool_result,
    nativeCost: nativeC, wireCost: wireC, trCost: trC,
    perPrompt,
  }, null, 2));
  console.log('  Saved: ' + file + '\n');
}

// ── Compare ──────────────────────────────────────────────

async function showComparison() {
  const fs = await import('fs');
  const url = new URL('../results/', import.meta.url);
  const dir = url.pathname;
  fs.mkdirSync(dir, { recursive: true });
  const files = fs.readdirSync(dir).filter((f: string) => f.endsWith('.json')).sort().reverse().slice(0, 5);
  if (!files.length) { console.log('No saved results.'); return; }

  const runs = files.map((f: string) => JSON.parse(fs.readFileSync(dir + f, 'utf-8')));

  console.log('\n  ' + '='.repeat(54));
  console.log('  Benchmark Comparison (last ' + runs.length + ' runs)');
  console.log('  ' + '='.repeat(54) + '\n');

  for (const run of runs) {
    console.log('  ' + run.model);
    console.log('  ' + '─'.repeat(40));
    console.log('    Native:  out=' + run.native.out + '  in=' + run.native.in + '  acc=' + run.native.acc + '/11  $' + (run.nativeCost * 1000).toFixed(3));
    const wS = ((1 - run.wire.out / run.native.out) * 100).toFixed(1);
    console.log('    Wire:    out=' + run.wire.out + ' (' + wS + '%)  in=' + run.wire.in + '  acc=' + run.wire.acc + '/11  $' + (run.wireCost * 1000).toFixed(3) + (run.wireCost < run.nativeCost ? ' ✅' : ' ❌'));
    const tS = ((1 - run.tool_result.out / run.native.out) * 100).toFixed(1);
    console.log('    TR:      out=' + run.tool_result.out + ' (' + tS + '%)  in=' + run.tool_result.in + '  acc=' + run.tool_result.acc + '/11  $' + (run.trCost * 1000).toFixed(3) + (run.trCost < run.nativeCost ? ' ✅' : ' ❌'));
    console.log('');
  }

  if (process.argv.includes('--save')) {
    const md: string[] = ['# Tool Calling Benchmark Comparison\n', 'Generated: ' + new Date().toISOString().slice(0, 10) + '\n'];
    md.push('| Model | Out (N) | In (N) | Acc (N) | Out (W) | Save (W) | Acc (W) | Cost (W) | Out (TR) | Save (TR) | Acc (TR) | Cost (TR) |\n');
    md.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\n');
    for (const run of runs) {
      const wS = ((1 - run.wire.out / run.native.out) * 100).toFixed(1);
      const tS = ((1 - run.tool_result.out / run.native.out) * 100).toFixed(1);
      md.push('| ' + run.model + ' | ' + run.native.out + ' | ' + run.native.in + ' | ' + run.native.acc + '/11 | ' + run.wire.out + ' | ' + wS + '% | ' + run.wire.acc + '/11 | $' + (run.wireCost * 1000).toFixed(3) + ' | ' + run.tool_result.out + ' | ' + tS + '% | ' + run.tool_result.acc + '/11 | $' + (run.trCost * 1000).toFixed(3) + ' |\n');
    }
    const mdf = dir + 'comparison-' + Date.now() + '.md';
    fs.writeFileSync(mdf, md.join(''));
    console.log('  Markdown: ' + mdf);
  }
  console.log('');
}

if (process.argv.includes('--compare')) showComparison(); else runBenchmark();
