/**
 * A/B test: Force compact format by injecting COMPLETE cycle examples.
 * 
 * Tests 3 approaches:
 * 1. Control: no examples
 * 2. Compact call only: inject <call>...</call> in assistant message
 * 3. FULL CYCLE: inject <call> AND <tool_result> so model sees the complete round-trip
 */

import Anthropic from '@anthropic-ai/sdk';
import { findCallSpans } from '../src/parser.ts';

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error('Set ANTHROPIC_API_KEY');
  process.exit(1);
}

const modelArg = process.argv.find(a => a.startsWith('--model='));
const modelIdx = process.argv.indexOf('--model');
const MODEL = modelArg ? modelArg.split('=')[1] : (modelIdx >= 0 ? process.argv[modelIdx + 1] : 'claude-haiku-4-5');

const tools = [
  { name: 'get_weather', description: 'Get weather', input_schema: { type: 'object', properties: { location: { type: 'string' }, units: { type: 'string', enum: ['metric', 'imperial'] } }, required: ['location'] } },
  { name: 'search_products', description: 'Search products', input_schema: { type: 'object', properties: { query: { type: 'string' }, max_results: { type: 'integer' }, in_stock: { type: 'boolean' } }, required: ['query'] } },
  { name: 'calculate', description: 'Math', input_schema: { type: 'object', properties: { expression: { type: 'string' } }, required: ['expression'] } },
  { name: 'send_email', description: 'Send email', input_schema: { type: 'object', properties: { to: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' }, priority: { type: 'string', enum: ['low', 'normal', 'high'] } }, required: ['to', 'subject', 'body'] } },
];

// ── Variants ─────────────────────────────────────────────

const variants = {
  control: {
    name: 'Control',
    messages: (userPrompt: string) => [
      { role: 'user', content: userPrompt },
    ],
  },
  compactCallOnly: {
    name: 'Compact Call Only',
    messages: (userPrompt: string) => [
      { role: 'user', content: 'Show me an example tool call' },
      { role: 'assistant', content: 'Here is how I call tools:\n\n<call>get_weather location=Austin units=imperial</call>' },
      { role: 'user', content: userPrompt },
    ],
  },
  fullCycle: {
    name: 'Full Cycle (Call + Result)',
    messages: (userPrompt: string) => [
      { role: 'user', content: 'Show me a complete tool call and response cycle' },
      { role: 'assistant', content: 'I will call a tool using this format:\n\n<call>get_weather location=Austin units=imperial</call>' },
      { role: 'user', content: '<tool_result name="get_weather">{"location":"Austin","temperature":72,"units":"imperial","condition":"sunny"}</tool_result>' },
      { role: 'assistant', content: 'The weather in Austin is 72°F and sunny.' },
      { role: 'user', content: 'Now ' + userPrompt },
    ],
  },
};

// ── Test prompts ────────────────────────────────────────

const testPrompts = [
  { id: 1, text: 'What is the weather in Austin?' },
  { id: 2, text: 'Search for wireless earbuds.' },
  { id: 3, text: 'Calculate 29.99 * 1.08' },
  { id: 4, text: 'What is the weather in Tokyo and London? Use metric units for both.' },
  { id: 5, text: 'Search for running shoes, max 5 results, in stock only.' },
  { id: 6, text: 'Get the weather in Austin and Dallas, then calculate the average temperature.' },
];

// ── Test runner ──────────────────────────────────────

async function runTest(client: Anthropic, variant: string, getMessages: (prompt: string) => any[], prompt: string): Promise<{
  variant: string;
  outputFormat: 'compact' | 'native' | 'none';
  outputTokens: number;
  compactCalls: number;
  nativeCalls: number;
}> {
  try {
    const messages = getMessages(prompt);

    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      tools: tools as any,
      messages: messages as any,
    } as any);

    if (!response?.content || !Array.isArray(response.content)) {
      throw new Error('Invalid response');
    }
    if (!response?.usage) {
      throw new Error('No usage');
    }

    const textContent = response.content
      .filter((b: any) => b && b.type === 'text')
      .map((b: any) => (b && b.text) || '')
      .join('\n');

    const compactCallSpans = findCallSpans(textContent);
    const compactCalls = compactCallSpans ? compactCallSpans.length : 0;

    const toolUseBlocks = response.content.filter((b: any) => b && b.type === 'tool_use') || [];
    const nativeCalls = toolUseBlocks.length;

    const outputFormat = compactCalls > 0 ? 'compact' : (nativeCalls > 0 ? 'native' : 'none');

    return {
      variant,
      outputFormat,
      outputTokens: response.usage.output_tokens || 0,
      compactCalls,
      nativeCalls,
    };
  } catch (err) {
    return {
      variant,
      outputFormat: 'none',
      outputTokens: 0,
      compactCalls: 0,
      nativeCalls: 0,
    };
  }
}

// ── Main ─────────────────────────────────────────────

async function main() {
  const client = new Anthropic({ apiKey });

  console.log('');
  console.log('  ' + '='.repeat(80));
  console.log('    A/B Test: Full Cycle Examples (Call + Result)');
  console.log('    Model: ' + MODEL);
  console.log('    3 variants × 6 prompts = 18 API calls');
  console.log('  ' + '='.repeat(80));
  console.log('');

  const allResults: any[] = [];

  for (const [variantKey, variant] of Object.entries(variants)) {
    console.log('  ' + variant.name.padEnd(25));
    console.log('  ' + '─'.repeat(80));

    const variantResults = [];

    for (const prompt of testPrompts) {
      process.stdout.write('    [' + String(prompt.id).padStart(2) + '] ' + prompt.text.slice(0, 50).padEnd(52));

      const result = await runTest(client, variant.name, variant.messages, prompt.text);
      variantResults.push(result);
      allResults.push(result);

      const formatIcon = result.outputFormat === 'compact' ? '◊' : (result.outputFormat === 'native' ? '●' : '○');
      const formatLabel = result.outputFormat.padEnd(7);
      const callsLabel = 'c:' + String(result.compactCalls).padStart(2) + ' n:' + String(result.nativeCalls).padStart(2);
      const tokLabel = String(result.outputTokens).padStart(4) + ' tok';

      console.log(formatIcon + ' ' + formatLabel + callsLabel.padStart(15) + '  ' + tokLabel);
    }

    const compactCount = variantResults.filter(r => r.outputFormat === 'compact').length;
    const nativeCount = variantResults.filter(r => r.outputFormat === 'native').length;
    const avgOut = variantResults.reduce((a, r) => a + r.outputTokens, 0) / variantResults.length;

    console.log('  ' + '─'.repeat(80));
    console.log('  → Compact: ' + String(compactCount).padStart(2) + '/6 (' + ((compactCount / 6) * 100).toFixed(0).padStart(3) + '%)  Native: ' + String(nativeCount).padStart(2) + '/6  Avg out: ' + Math.round(avgOut) + ' tok');
    console.log('');
  }

  // Final comparison
  console.log('  ' + '='.repeat(80));
  console.log('    RESULTS');
  console.log('  ' + '='.repeat(80));
  console.log('');

  for (const [variantKey, variant] of Object.entries(variants)) {
    const variantResults = allResults.filter(r => r.variant === variant.name);
    const compactCount = variantResults.filter(r => r.outputFormat === 'compact').length;
    const nativeCount = variantResults.filter(r => r.outputFormat === 'native').length;
    const avgOut = variantResults.filter(r => r.outputFormat !== 'none').reduce((a, r) => a + r.outputTokens, 0) / Math.max(1, variantResults.filter(r => r.outputFormat !== 'none').length);

    const compactRate = ((compactCount / 6) * 100).toFixed(0);

    console.log('  ' + variant.name.padEnd(25) + 'Compact: ' + String(compactCount).padStart(2) + '/6 (' + compactRate.padStart(3) + '%)  Native: ' + String(nativeCount).padStart(2) + '/6  Avg out: ' + Math.round(avgOut) + ' tok');
  }

  console.log('');

  const variantScores = Object.entries(variants).map(([key, variant]) => {
    const variantResults = allResults.filter(r => r.variant === variant.name);
    const compactCount = variantResults.filter(r => r.outputFormat === 'compact').length;
    return { name: variant.name, compactCount };
  });

  const winner = variantScores.reduce((best, curr) => curr.compactCount > best.compactCount ? curr : best);
  console.log('  🏆 Winner: ' + winner.name + ' (' + winner.compactCount + '/6 compact adoption)');
  console.log('');
}

await main();
