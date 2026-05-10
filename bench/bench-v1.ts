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
  haiku: [1, 5],
  sonnet: [3, 15],
  opus: [5, 25],
};
const modelKey = MODEL.includes('haiku') ? 'haiku' : MODEL.includes('opus') ? 'opus' : 'sonnet';
const [IN_RATE, OUT_RATE] = PRICING[modelKey];

const tools: MessagesCreateParams['tools'] = [
  {
    name: 'get_weather',
    description: 'Get the current weather for a location',
    input_schema: {
      type: 'object',
      properties: {
        location: { type: 'string' },
        units: { type: 'string', enum: ['metric', 'imperial'] },
      },
      required: ['location'],
    },
  },
  {
    name: 'search_products',
    description: 'Search a product catalog',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        max_results: { type: 'integer' },
        in_stock: { type: 'boolean' },
      },
      required: ['query'],
    },
  },
  {
    name: 'calculate',
    description: 'Evaluate a mathematical expression',
    input_schema: {
      type: 'object',
      properties: { expression: { type: 'string' } },
      required: ['expression'],
    },
  },
  {
    name: 'send_email',
    description: 'Send an email to a recipient',
    input_schema: {
      type: 'object',
      properties: {
        to: { type: 'string' },
        subject: { type: 'string' },
        body: { type: 'string' },
        priority: { type: 'string', enum: ['low', 'normal', 'high'] },
      },
      required: ['to', 'subject', 'body'],
    },
  },
];

interface TaskDef {
  diff: number;
  text: string;
  requires: string[];
  checks: ((calls: any[]) => boolean)[];
}

const tasks: TaskDef[] = [
  {
    diff: 0,
    text: 'What is the weather in Austin?',
    requires: ['get_weather'],
    checks: [(c: any[]) => c.some((x: any) => x.name === 'get_weather')],
  },
  {
    diff: 1,
    text: 'Search for wireless earbuds.',
    requires: ['search_products'],
    checks: [(c: any[]) => c.some((x: any) => x.name === 'search_products')],
  },
  {
    diff: 2,
    text: 'Calculate 29.99 * 1.08',
    requires: ['calculate'],
    checks: [(c: any[]) => c.some((x: any) => x.name === 'calculate')],
  },
  {
    diff: 3,
    text: 'What is the weather in Tokyo and London? Use metric units for both.',
    requires: ['get_weather', 'get_weather'],
    checks: [(c: any[]) => c.filter((x: any) => x.name === 'get_weather').length >= 2],
  },
  {
    diff: 4,
    text: 'Search for running shoes, max 5 results, in stock only.',
    requires: ['search_products'],
    checks: [
      (c: any[]) => {
        const s = c.find((x: any) => x.name === 'search_products');
        return s && s.input && s.input.max_results === 5;
      },
    ],
  },
  {
    diff: 5,
    text: 'Get the weather in Austin and Dallas, then calculate the average temperature.',
    requires: ['get_weather', 'get_weather', 'calculate'],
    checks: [
      (c: any[]) =>
        c.filter((x: any) => x.name === 'get_weather').length >= 2 &&
        c.filter((x: any) => x.name === 'calculate').length >= 1,
    ],
  },
  {
    diff: 6,
    text: 'Search for noise-canceling headphones, max 3 results. For the first result, calculate the price with 15% tax.',
    requires: ['search_products', 'calculate'],
    checks: [
      (c: any[]) => {
        const s = c.find((x: any) => x.name === 'search_products');
        return s && s.input?.max_results === 3;
      },
    ],
  },
  {
    diff: 7,
    text: 'What is the weather in New York, London, and Tokyo? Use imperial for US, metric for others. Then email to me@example.com.',
    requires: ['get_weather', 'get_weather', 'get_weather', 'send_email'],
    checks: [
      (c: any[]) =>
        c.filter((x: any) => x.name === 'get_weather').length >= 3 &&
        c.filter((x: any) => x.name === 'send_email').length >= 1,
    ],
  },
  {
    diff: 8,
    text: 'Search for "wireless mechanical keyboard" (in stock). Find the price of the first result. Calculate total with 8.25% tax and 10% coupon on pre-tax.',
    requires: ['search_products', 'calculate', 'calculate'],
    checks: [(c: any[]) => c.filter((x: any) => x.name === 'calculate').length >= 2],
  },
  {
    diff: 9,
    text: 'Get the weather in 5 cities across 3 continents. For cities below 60°F, calculate the difference from 72°F. Email report to report@example.com at high priority.',
    requires: ['get_weather', 'get_weather', 'get_weather', 'get_weather', 'get_weather', 'calculate', 'send_email'],
    checks: [
      (c: any[]) =>
        c.filter((x: any) => x.name === 'get_weather').length >= 4 &&
        c.filter((x: any) => x.name === 'send_email').length >= 1,
    ],
  },
  {
    diff: 10,
    text: 'Search for three product categories (electronics, sports, home). For each get first in-stock result. Calculate total with 7.5% tax and 20% discount. Get weather in top 3 cities. Email report.',
    requires: ['search_products', 'search_products', 'search_products', 'calculate', 'calculate', 'get_weather', 'send_email'],
    checks: [
      (c: any[]) =>
        c.filter((x: any) => x.name === 'search_products').length >= 2 &&
        c.filter((x: any) => x.name === 'calculate').length >= 1 &&
        c.filter((x: any) => x.name === 'send_email').length >= 1,
    ],
  },
];

// ── Helpers ──────────────────────────────────────────────────

const MODE_LABELS: Record<string, string> = {
  native: 'Native',
  wire: 'Wire',
  tool_result: 'ToolResult',
};

function fmtNum(n: number): string {
  return n.toLocaleString();
}

function cost(out: number, inp: number): number {
  return (out / 1_000_000) * OUT_RATE + (inp / 1_000_000) * IN_RATE;
}

function pctChange(a: number, b: number): string {
  if (b === 0) return '—';
  const d = ((a - b) / b) * 100;
  return (d >= 0 ? '+' : '') + d.toFixed(1) + '%';
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

// ── Run ──────────────────────────────────────────────────────

async function runBenchmark() {
  const client = new Anthropic({ apiKey });

  async function runOne(mode: string, text: string, task: TaskDef) {
    const start = Date.now();
    try {
      const base: MessagesCreateParams = {
        model: MODEL,
        max_tokens: 2048,
        tools,
        messages: [{ role: 'user', content: text }],
      };
      let response: MessageResponse;

      if (mode === 'native') {
        response = await client.messages.create(base);
      } else {
        const opts = {
          syntax: mode as 'wire' | 'tool_result',
          placement: 'system' as const,
          rewriteHistory: false,
          minifyToolDefinitions: false,
          stripTools: true,
        };
        const { params: transformed, plans } = transformRequest(base, opts);
        response = transformResponse(
          await client.messages.create(transformed as any),
          plans,
        );
      }

      const calledTools = response.content.filter((b: any) => b.type === 'tool_use');
      const names = calledTools.map((b: any) => b.name);
      const inputs = calledTools.map((b: any) => b.input);
      return {
        mode,
        diff: task.diff,
        ok: true,
        in: response.usage.input_tokens,
        out: response.usage.output_tokens,
        calls: calledTools.length,
        names,
        acc: task.requires.every((t) => names.includes(t)),
        pass: task.checks.every((c) => c(inputs)),
        ms: Date.now() - start,
      };
    } catch (err) {
      return {
        mode,
        diff: task.diff,
        ok: false,
        in: 0,
        out: 0,
        calls: 0,
        names: [],
        acc: false,
        pass: false,
        ms: Date.now() - start,
        error: (err as Error).message,
      };
    }
  }

  // ── Header ────────────────────────────────────────────────

  console.log('');
  console.log(
    '  ═══════════════════════════════════════════════════════════════',
  );
  console.log(
    '  │   Compact Tool Calling — Live Benchmark                    │',
  );
  console.log(
    '  │   Model: ' +
      MODEL.padEnd(48) + '│',
  );
  console.log(
    '  │   ' +
      tasks.length +
      ' prompts × 3 modes = ' +
      (tasks.length * 3) +
      ' API calls' +
      ' '.repeat(14) + '│',
  );
  console.log(
    '  │   Pricing: $' +
      IN_RATE +
      '.00/M in · $' +
      OUT_RATE +
      '.00/M out' +
      ' '.repeat(17) + '│',
  );
  console.log(
    '  ═══════════════════════════════════════════════════════════════',
  );
  console.log('');

  // ── Per-prompt progress ───────────────────────────────────

  const results: any[] = [];
  const summary: any = {
    native: { out: 0, in: 0, acc: 0 },
    wire: { out: 0, in: 0, acc: 0 },
    tool_result: { out: 0, in: 0, acc: 0 },
  };

  for (const task of tasks) {
    const line = truncate(task.text, 58).padEnd(60);

    process.stdout.write(
      '  [' + String(task.diff).padStart(2) + '] ' + line + '\n' + '      ',
    );

    for (const [mi, mode] of (['native', 'wire', 'tool_result'] as const).entries()) {
      const r = await runOne(mode, task.text, task);
      results.push(r);
      summary[mode].out += r.out;
      summary[mode].in += r.in;
      if (r.acc) summary[mode].acc++;

      const label = MODE_LABELS[mode];
      const tok = String(r.out).padStart(4);
      const mark = r.acc ? '✓' : '✗';
      const errFlag = r.error ? ' !' : '  ';
      process.stdout.write(
        label + ': ' + tok + ' tok ' + mark + errFlag + '   ',
      );
    }
    process.stdout.write('\n');
  }

  // ── Check for total failure ────────────────────────────────

  const firstError = results.find((r: any) => r.error);
  if (firstError && summary.native.out === 0) {
    console.log('');
    console.log('  ⚠  All calls returned 0 tokens. First error:');
    console.log('     ' + firstError.error);
    console.log('');
    console.log('  Tip: Verify the model name is correct.');
    console.log('       Valid: claude-sonnet-4-5, claude-opus-4-7, claude-haiku-4-5');
    console.log('');
    return;
  }

  // ── Summary table ──────────────────────────────────────────

  const s = summary;

  const nativeC = cost(s.native.out, s.native.in);
  const wireC = cost(s.wire.out, s.wire.in);
  const trC = cost(s.tool_result.out, s.tool_result.in);

  const nativeC10k = nativeC * 10_000;
  const wireC10k = wireC * 10_000;
  const trC10k = trC * 10_000;

  const wireDelta = wireC - nativeC;
  const trDelta = trC - nativeC;

  function recommend(delta: number, accEq: boolean): string {
    if (delta > 0) return '❌  Worse';
    if (delta === 0 && accEq) return '⚡  Same cost';
    if (delta < 0 && accEq) return '✅  Save $';
    if (delta < 0 && !accEq) return '⚠️  Trade-off';
    return '❌  Worse';
  }

  const wireAccEq = s.wire.acc >= s.native.acc;
  const trAccEq = s.tool_result.acc >= s.native.acc;

  console.log('');
  console.log(
    '  ═══════════════════════════════════════════════════════════════',
  );
  console.log(
    '  │                     RESULTS — ' + MODEL.padEnd(38) + '│',
  );
  console.log(
    '  ═══════════════════════════════════════════════════════════════',
  );
  console.log('');
  console.log(
    '  ┌─────────────────────────┬─────────────┬─────────────┬─────────────┐',
  );
  console.log(
    '  │ Metric                  │      Native │        Wire │  ToolResult │',
  );
  console.log(
    '  ├─────────────────────────┼─────────────┼─────────────┼─────────────┤',
  );
  console.log(
    '  │ Output tokens           │ ' +
      fmtNum(s.native.out).padStart(11) +
      ' │ ' +
      fmtNum(s.wire.out).padStart(11) +
      ' │ ' +
      fmtNum(s.tool_result.out).padStart(11) +
      ' │',
  );
  console.log(
    '  │   Δ vs Native           │           — │ ' +
      pctChange(s.wire.out, s.native.out).padStart(11) +
      ' │ ' +
      pctChange(s.tool_result.out, s.native.out).padStart(11) +
      ' │',
  );
  console.log(
    '  │ Input tokens            │ ' +
      fmtNum(s.native.in).padStart(11) +
      ' │ ' +
      fmtNum(s.wire.in).padStart(11) +
      ' │ ' +
      fmtNum(s.tool_result.in).padStart(11) +
      ' │',
  );
  console.log(
    '  │   Δ vs Native           │           — │ ' +
      pctChange(s.wire.in, s.native.in).padStart(11) +
      ' │ ' +
      pctChange(s.tool_result.in, s.native.in).padStart(11) +
      ' │',
  );
  console.log(
    '  │ Accuracy                │ ' +
      (s.native.acc + '/' + tasks.length).padStart(11) +
      ' │ ' +
      (s.wire.acc + '/' + tasks.length).padStart(11) +
      ' │ ' +
      (s.tool_result.acc + '/' + tasks.length).padStart(11) +
      ' │',
  );
  console.log(
    '  │   Δ vs Native           │           — │ ' +
      (s.wire.acc === s.native.acc
        ? '      same'
        : s.wire.acc > s.native.acc
          ? '   +' + (s.wire.acc - s.native.acc)
          : '   -' + (s.native.acc - s.wire.acc)).padStart(11) +
      ' │ ' +
      (s.tool_result.acc === s.native.acc
        ? '      same'
        : s.tool_result.acc > s.native.acc
          ? '   +' + (s.tool_result.acc - s.native.acc)
          : '   -' + (s.native.acc - s.tool_result.acc)).padStart(11) +
      ' │',
  );
  console.log(
    '  ├─────────────────────────┼─────────────┼─────────────┼─────────────┤',
  );
  console.log(
    '  │ Cost (this run)         ' +
    ' │    $' +
      (nativeC).toFixed(4).padStart(8) +
      ' │    $' +
      (wireC).toFixed(4).padStart(8) +
      ' │    $' +
      (trC).toFixed(4).padStart(8) +
      ' │',
  );
  console.log(
    '  │   Δ vs Native           │           — │ ' +
      (wireDelta > 0 ? '+' : '') +
      (wireDelta * 100).toFixed(2) +
      '¢'.padStart(10) +
      ' │ ' +
      (trDelta > 0 ? '+' : '') +
      (trDelta * 100).toFixed(2) +
      '¢'.padStart(10) +
      ' │',
  );
  console.log(
    '  │ Cost @ 1K calls/day     ' +
    ' │   $' +
      (nativeC * 1000).toFixed(2).padStart(8) +
      ' │   $' +
      (wireC * 1000).toFixed(2).padStart(8) +
      ' │   $' +
      (trC * 1000).toFixed(2).padStart(8) +
      ' │',
  );
  console.log(
    '  │ Cost @ 10K calls/day    ' +
    ' │   $' +
      (nativeC10k).toFixed(2).padStart(8) +
      ' │   $' +
      (wireC10k).toFixed(2).padStart(8) +
      ' │   $' +
      (trC10k).toFixed(2).padStart(8) +
      ' │',
  );
  console.log(
    '  ├─────────────────────────┼─────────────┼─────────────┼─────────────┤',
  );
  console.log(
    '  │ Recommendation           │   (baseline) │ ' +
      recommend(wireDelta, wireAccEq).padStart(11) +
      ' │ ' +
      recommend(trDelta, trAccEq).padStart(11) +
      ' │',
  );
  console.log(
    '  └─────────────────────────┴─────────────┴─────────────┴─────────────┘',
  );
  console.log('');

  // ── Save results ──────────────────────────────────────────

  const perPrompt = tasks.map((task) => {
    const n = results.find(
      (r: any) => r.mode === 'native' && r.diff === task.diff,
    );
    const w = results.find(
      (r: any) => r.mode === 'wire' && r.diff === task.diff,
    );
    const t = results.find(
      (r: any) => r.mode === 'tool_result' && r.diff === task.diff,
    );
    return {
      diff: task.diff,
      native: n.out,
      wire: w.out,
      tr: t.out,
      nOk: n.acc,
      wOk: w.acc,
      tOk: t.acc,
    };
  });

  const url = new URL('../results/', import.meta.url);
  const fs = await import('fs');
  fs.mkdirSync(url.pathname, { recursive: true });
  const file =
    url.pathname +
    MODEL.replace(/[^a-z0-9.-]/gi, '_') +
    '-' +
    Date.now() +
    '.json';
  fs.writeFileSync(
    file,
    JSON.stringify(
      {
        model: MODEL,
        timestamp: new Date().toISOString(),
        pricing: { input: IN_RATE, output: OUT_RATE },
        native: s.native,
        wire: s.wire,
        tr: s.tool_result,
        nativeCost: nativeC,
        wireCost: wireC,
        trCost: trC,
        perPrompt,
      },
      null,
      2,
    ),
  );
  console.log('  Results saved: ' + file + '\n');
}

// ── Compare ──────────────────────────────────────────────────

async function showComparison() {
  const fs = await import('fs');
  const url = new URL('../results/', import.meta.url);
  const dir = url.pathname;
  fs.mkdirSync(dir, { recursive: true });
  const files = fs
    .readdirSync(dir)
    .filter((f: string) => f.endsWith('.json'))
    .sort()
    .reverse()
    .slice(0, 5);
  if (!files.length) {
    console.log('No saved results.');
    return;
  }

  const runs = files.map((f: string) =>
    JSON.parse(fs.readFileSync(dir + f, 'utf-8')),
  );

  console.log('');
  console.log(
    '  ═══════════════════════════════════════════════════════════════',
  );
  console.log('  │   Benchmark Comparison (last ' + runs.length + ' runs)');
  console.log(
    '  ═══════════════════════════════════════════════════════════════',
  );
  console.log('');

  for (const run of runs) {
    // Normalize across result-file formats
    const n = run.native ?? { out: run.nativeTotal, in: 0, acc: run.nativeAcc };
    const w = run.wire ?? { out: run.wireTotal, in: 0, acc: run.wireAcc };
    const t = run.tr ?? run.tool_result ?? { out: run.trTotal, in: 0, acc: run.trAcc };
    const nativeOut = typeof n === 'number' ? n : n.out;
    const wireOut = typeof w === 'number' ? w : w.out;
    const trOut = typeof t === 'number' ? t : t.out;
    const nativeAcc = typeof n === 'number' ? 0 : (n.acc ?? 0);
    const wireAcc = typeof w === 'number' ? 0 : (w.acc ?? 0);
    const trAcc = typeof t === 'number' ? 0 : (t.acc ?? 0);
    const nativeIn = typeof n === 'number' ? 0 : (n.in ?? 0);
    const wireIn = typeof w === 'number' ? 0 : (w.in ?? 0);
    const trIn = typeof t === 'number' ? 0 : (t.in ?? 0);

    const nativeC = run.nativeCost ?? cost(nativeOut, nativeIn);
    const wireC = run.wireCost ?? cost(wireOut, wireIn);
    const trC = run.trCost ?? cost(trOut, trIn);

    const wPct = pctChange(wireOut, nativeOut);
    const tPct = pctChange(trOut, nativeOut);

    console.log('  ' + run.model);
    console.log(
      '  ┌──────────────────┬───────────┬───────────┬───────────┐',
    );
    console.log(
      '  │ Metric           │    Native │      Wire │ ToolResult│',
    );
    console.log(
      '  ├──────────────────┼───────────┼───────────┼───────────┤',
    );
    console.log(
      '  │ Output           │ ' +
        fmtNum(nativeOut).padStart(9) +
        ' │ ' +
        fmtNum(wireOut).padStart(9) +
        ' │ ' +
        fmtNum(trOut).padStart(9) +
        ' │',
    );
    console.log(
      '  │   vs Native      │         — │ ' +
        wPct.padStart(9) +
        ' │ ' +
        tPct.padStart(9) +
        ' │',
    );
    console.log(
      '  │ Input            │ ' +
        fmtNum(nativeIn).padStart(9) +
        ' │ ' +
        fmtNum(wireIn).padStart(9) +
        ' │ ' +
        fmtNum(trIn).padStart(9) +
        ' │',
    );
    console.log(
      '  │ Accuracy         │ ' +
        (nativeAcc + '/' + tasks.length).padStart(9) +
        ' │ ' +
        (wireAcc + '/' + tasks.length).padStart(9) +
        ' │ ' +
        (trAcc + '/' + tasks.length).padStart(9) +
        ' │',
    );
    console.log(
      '  │ Cost             │  $' +
        (nativeC).toFixed(4).padStart(6) +
        ' │  $' +
        (wireC).toFixed(4).padStart(6) +
        ' │  $' +
        (trC).toFixed(4).padStart(6) +
        ' │',
    );
    console.log(
      '  └──────────────────┴───────────┴───────────┴───────────┘',
    );
    console.log('');
  }

  if (process.argv.includes('--save')) {
    const md: string[] = [
      '# Tool Calling Benchmark Comparison\n',
      'Generated: ' + new Date().toISOString().slice(0, 10) + '\n',
    ];
    md.push(
      '| Model | Out (N) | Δ Out (W) | Δ Out (TR) | Acc (N) | Acc (W) | Acc (TR) | Cost (N) | Cost (W) | Cost (TR) |\n',
    );
    md.push(
      '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\n',
    );
    for (const run of runs) {
      const n = run.native ?? { out: run.nativeTotal, in: 0, acc: run.nativeAcc };
      const w = run.wire ?? { out: run.wireTotal, in: 0, acc: run.wireAcc };
      const t = run.tr ?? run.tool_result ?? { out: run.trTotal, in: 0, acc: run.trAcc };
      const nativeOut = typeof n === 'number' ? n : n.out;
      const wireOut = typeof w === 'number' ? w : w.out;
      const trOut = typeof t === 'number' ? t : t.out;
      const nativeAcc = typeof n === 'number' ? 0 : (n.acc ?? 0);
      const wireAcc = typeof w === 'number' ? 0 : (w.acc ?? 0);
      const trAcc = typeof t === 'number' ? 0 : (t.acc ?? 0);
      const wPct = pctChange(wireOut, nativeOut);
      const tPct = pctChange(trOut, nativeOut);
      const nativeC = run.nativeCost ?? cost(nativeOut, 0);
      const wireC = run.wireCost ?? cost(wireOut, 0);
      const trC = run.trCost ?? cost(trOut, 0);
      md.push(
        '| ' +
          run.model +
          ' | ' +
          nativeOut +
          ' | ' +
          wPct +
          ' | ' +
          tPct +
          ' | ' +
          nativeAcc +
          '/11 | ' +
          wireAcc +
          '/11 | ' +
          trAcc +
          '/11 | $' +
          (nativeC * 1000).toFixed(3) +
          ' | $' +
          (wireC * 1000).toFixed(3) +
          ' | $' +
          (trC * 1000).toFixed(3) +
          ' |\n',
      );
    }
    const mdf = dir + 'comparison-' + Date.now() + '.md';
    fs.writeFileSync(mdf, md.join(''));
    console.log('  Markdown saved: ' + mdf);
  }
  console.log('');
}

if (process.argv.includes('--compare')) showComparison();
else runBenchmark();
