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
  console.log('\n══════════════════════════════════════════════════');
  console.log('  Compact Tool Calling — A/B Comparison');
  console.log(`  Model: ${MODEL}`);
  console.log(`  Prompt: "${PROMPT}"`);
  console.log('══════════════════════════════════════════════════\n');

  const native = await run('native');
  const wire = await run('wire');
  const tr = await run('tool_result');

  function row(r: typeof native) {
    const savings = r.mode === 'native' ? '—' : ((1 - r.outputTok / native.outputTok) * 100).toFixed(1) + '%';
    return `  ${r.mode.padEnd(12)} ${r.outputTok.toString().padStart(5)} tok out  ${r.inputTok.toString().padStart(6)} tok in  ${r.totalTok.toString().padStart(6)} tok total  ${r.elapsedMs}ms  calls:${r.toolCalls}  ${savings}`;
  }

  console.log('  ┌──────────────┬──────────┬──────────┬──────────┬────────┬────────┬────────┐');
  console.log('  │ Mode         │ Output   │ Input    │ Total    │ Time   │ Calls  │ Saving │');
  console.log('  ├──────────────┼──────────┼──────────┼──────────┼────────┼────────┼────────┤');
  console.log(`  │ ${native.mode.padEnd(12)} │ ${native.outputTok.toString().padEnd(8)} │ ${native.inputTok.toString().padEnd(8)} │ ${native.totalTok.toString().padEnd(8)} │ ${native.elapsedMs.toString().padEnd(6)} │ ${native.toolCalls.toString().padEnd(6)} │ ${'—'.padEnd(6)} │`);
  console.log(`  │ ${wire.mode.padEnd(12)} │ ${wire.outputTok.toString().padEnd(8)} │ ${wire.inputTok.toString().padEnd(8)} │ ${wire.totalTok.toString().padEnd(8)} │ ${wire.elapsedMs.toString().padEnd(6)} │ ${wire.toolCalls.toString().padEnd(6)} │ ${((1 - wire.outputTok / native.outputTok) * 100).toFixed(1)+'%'.padEnd(5)} │`);
  console.log(`  │ ${tr.mode.padEnd(12)} │ ${tr.outputTok.toString().padEnd(8)} │ ${tr.inputTok.toString().padEnd(8)} │ ${tr.totalTok.toString().padEnd(8)} │ ${tr.elapsedMs.toString().padEnd(6)} │ ${tr.toolCalls.toString().padEnd(6)} │ ${((1 - tr.outputTok / native.outputTok) * 100).toFixed(1)+'%'.padEnd(5)} │`);
  console.log('  └──────────────┴──────────┴──────────┴──────────┴────────┴────────┴────────┘');

  console.log('\n  Tool calls:', native.toolNames);
  console.log('');
  console.log(`  Wire output savings:      ${((1 - wire.outputTok / native.outputTok) * 100).toFixed(1)}%`);
  console.log(`  ToolResult output savings: ${((1 - tr.outputTok / native.outputTok) * 100).toFixed(1)}%`);
  console.log('');

  // Cost estimate
  const OUTPUT_COST = 15; // $/M tok Sonnet
  const INPUT_COST = 3;
  const nativeDollars = (native.outputTok / 1e6 * OUTPUT_COST + native.inputTok / 1e6 * INPUT_COST);
  const wireDollars = (wire.outputTok / 1e6 * OUTPUT_COST + wire.inputTok / 1e6 * INPUT_COST);
  console.log(`  Cost this call: native=$${nativeDollars.toFixed(5)}  wire=$${wireDollars.toFixed(5)}  (save $${(nativeDollars - wireDollars).toFixed(5)})`);
  console.log(`  Scaled to 10K calls/day: native=$${(nativeDollars * 10000).toFixed(2)}  wire=$${(wireDollars * 10000).toFixed(2)}  (save $${((nativeDollars - wireDollars) * 10000).toFixed(2)})`);
  console.log('');
}

main().catch(console.error);
