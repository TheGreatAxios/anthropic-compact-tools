/**
 * One-shot comparison: Native vs Compact on a single prompt.
 * Clean output, screenshot-ready.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-... bun run compare
 */

import Anthropic from '@anthropic-ai/sdk';
import { CompactAnthropic } from '../src/index.ts';

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) { console.error('Set ANTHROPIC_API_KEY'); process.exit(1); }

const MODEL = 'claude-sonnet-4-5';

const tools = [
  {
    name: 'get_weather',
    description: 'Get the current weather for a location',
    input_schema: {
      type: 'object',
      properties: {
        location: { type: 'string', description: 'City name' },
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
    description: 'Evaluate a math expression',
    input_schema: {
      type: 'object',
      properties: { expression: { type: 'string' } },
      required: ['expression'],
    },
  },
];

const PROMPT = 'Get the weather in Austin TX, search for wireless earbuds in stock, and calculate 29.99 * 1.08';

async function run(mode: string) {
  const start = Date.now();
  let response;

  if (mode === 'native') {
    const client = new Anthropic({ apiKey });
    response = await client.messages.create({
      model: MODEL, max_tokens: 1024, tools, messages: [{ role: 'user', content: PROMPT }],
    });
  } else {
    const client = new CompactAnthropic({ apiKey }, { syntax: mode as any, placement: 'first_user', rewriteHistory: false });
    response = await client.messages.create({
      model: MODEL, max_tokens: 1024, tools, messages: [{ role: 'user', content: PROMPT }],
    });
  }

  const toolCalls = response.content.filter((b: any) => b.type === 'tool_use');
  const inputTok = response.usage.input_tokens;
  const outputTok = response.usage.output_tokens;

  return {
    mode,
    inputTok,
    outputTok,
    totalTok: inputTok + outputTok,
    toolCalls: toolCalls.length,
    toolNames: toolCalls.map((b: any) => b.name).join(', '),
    elapsedMs: Date.now() - start,
  };
}

async function main() {
  console.log('');
  console.log('  ═══════════════════════════════════════════════════════════════');
  console.log('  │   Compact Tool Calling — A/B Comparison                    │');
  console.log('  │   Model: ' + MODEL.padEnd(48) + '│');
  console.log('  │   Prompt: "' + PROMPT.slice(0, 48).padEnd(48) + '│');
  console.log('  ═══════════════════════════════════════════════════════════════');
  console.log('');

  const native = await run('native');
  const wire = await run('wire');
  const tr = await run('tool_result');

  const fmt = (n: number) => n.toLocaleString();

  function makeRow(r: typeof native) {
    const savings = r.mode === 'native'
      ? '—'
      : ((1 - r.outputTok / native.outputTok) * 100).toFixed(1) + '%';
    return {
      mode: r.mode,
      out: r.outputTok,
      inp: r.inputTok,
      total: r.totalTok,
      ms: r.elapsedMs,
      calls: r.toolCalls,
      savings,
    };
  }

  const rows = [native, wire, tr].map(makeRow);

  console.log('  ┌──────────────┬───────────┬───────────┬───────────┬────────┬────────┬────────┐');
  console.log('  │ Mode         │    Output │     Input │     Total │   Time │  Calls │ Saving │');
  console.log('  ├──────────────┼───────────┼───────────┼───────────┼────────┼────────┼────────┤');
  for (const row of rows) {
    console.log(
      '  │ ' +
        row.mode.padEnd(12) +
        ' │ ' +
        fmt(row.out).padStart(9) +
        ' │ ' +
        fmt(row.inp).padStart(9) +
        ' │ ' +
        fmt(row.total).padStart(9) +
        ' │ ' +
        String(row.ms).padStart(6) +
        'ms' +
        ' │ ' +
        String(row.calls).padStart(6) +
        ' │ ' +
        row.savings.padStart(6) +
        ' │',
    );
  }
  console.log('  └──────────────┴───────────┴───────────┴───────────┴────────┴────────┴────────┘');

  console.log('');
  console.log('  Tool calls: ' + native.toolNames);
  console.log('');

  // Cost estimate
  const OUTPUT_COST = 15; // $/M tok Sonnet
  const INPUT_COST = 3;
  const nativeDollars = (native.outputTok / 1_000_000 * OUTPUT_COST + native.inputTok / 1_000_000 * INPUT_COST);
  const wireDollars = (wire.outputTok / 1_000_000 * OUTPUT_COST + wire.inputTok / 1_000_000 * INPUT_COST);
  const trDollars = (tr.outputTok / 1_000_000 * OUTPUT_COST + tr.inputTok / 1_000_000 * INPUT_COST);

  console.log('  Cost breakdown:');
  console.log('    Native:     $' + nativeDollars.toFixed(5) + '  (' + fmt(native.outputTok) + ' out · ' + fmt(native.inputTok) + ' in)');
  console.log('    Wire:       $' + wireDollars.toFixed(5) + '  (' + fmt(wire.outputTok) + ' out · ' + fmt(wire.inputTok) + ' in)' + (wireDollars < nativeDollars ? '  ✅' : '  ❌'));
  console.log('    ToolResult: $' + trDollars.toFixed(5) + '  (' + fmt(tr.outputTok) + ' out · ' + fmt(tr.inputTok) + ' in)' + (trDollars < nativeDollars ? '  ✅' : '  ❌'));

  const wireSave = nativeDollars - wireDollars;
  const trSave = nativeDollars - trDollars;
  console.log('');
  console.log('  Savings vs Native:');
  console.log('    Wire:       ' + (wireSave >= 0 ? '$' + wireSave.toFixed(5) + ' saved' : '$' + Math.abs(wireSave).toFixed(5) + ' extra') + '  (' + ((native.outputTok - wire.outputTok) / native.outputTok * 100).toFixed(1) + '% fewer out tok)');
  console.log('    ToolResult: ' + (trSave >= 0 ? '$' + trSave.toFixed(5) + ' saved' : '$' + Math.abs(trSave).toFixed(5) + ' extra') + '  (' + ((native.outputTok - tr.outputTok) / native.outputTok * 100).toFixed(1) + '% fewer out tok)');
  console.log('');

  const SCALE = 10_000;
  console.log('  At ' + fmt(SCALE) + ' calls/day:');
  console.log('    Native:     $' + (nativeDollars * SCALE).toFixed(2) + '/day');
  console.log('    Wire:       $' + (wireDollars * SCALE).toFixed(2) + '/day  (' + (wireSave >= 0 ? 'save $' + (wireSave * SCALE).toFixed(2) : 'cost $' + Math.abs(wireSave * SCALE).toFixed(2) + ' more') + ')');
  console.log('    ToolResult: $' + (trDollars * SCALE).toFixed(2) + '/day  (' + (trSave >= 0 ? 'save $' + (trSave * SCALE).toFixed(2) : 'cost $' + Math.abs(trSave * SCALE).toFixed(2) + ' more') + ')');
  console.log('');
}

main().catch(console.error);
