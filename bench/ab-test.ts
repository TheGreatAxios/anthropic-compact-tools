/**
 * A/B test: 4 format instruction variants on 6 proven prompts.
 * 
 * Variant 1: Control (no instruction)
 * Variant 2: Concise (short instruction + example)
 * Variant 3: Constraint (MUST use mandate)
 * Variant 4: System-level (instruction in system message)
 * 
 * Usage:
 *   ANTHROPIC_API_KEY=sk-... bun run ab-test
 *   ANTHROPIC_API_KEY=sk-... bun run ab-test --model claude-sonnet-4-5
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
  { name: 'get_weather', description: 'Get the current weather for a location', input_schema: { type: 'object', properties: { location: { type: 'string', description: 'City name' }, units: { type: 'string', enum: ['metric', 'imperial'], description: 'Temperature unit' } }, required: ['location'] } },
  { name: 'search_products', description: 'Search a product catalog', input_schema: { type: 'object', properties: { query: { type: 'string', description: 'Search query' }, max_results: { type: 'integer', description: 'Max results' }, in_stock: { type: 'boolean', description: 'Only in-stock' } }, required: ['query'] } },
  { name: 'calculate', description: 'Evaluate a math expression', input_schema: { type: 'object', properties: { expression: { type: 'string', description: 'Expression to evaluate' } }, required: ['expression'] } },
  { name: 'send_email', description: 'Send an email', input_schema: { type: 'object', properties: { to: { type: 'string', description: 'Recipient email' }, subject: { type: 'string', description: 'Subject line' }, body: { type: 'string', description: 'Body content' }, priority: { type: 'string', enum: ['low', 'normal', 'high'], description: 'Priority' } }, required: ['to', 'subject', 'body'] } },
];

// ── Format variants ──────────────────────────────────

const variants = {
  control: {
    name: 'Control',
    system: null,
    instruction: null,
  },
  concise: {
    name: 'Concise',
    system: null,
    instruction: `Use this tool format: <call>tool_name param=value</call>
Example: <call>get_weather location=Austin units=imperial</call>`,
  },
  constraint: {
    name: 'Constraint',
    system: null,
    instruction: `IMPORTANT: You MUST use this exact format for all tool calls:
<call>tool_name param=value</call>

Examples:
<call>get_weather location=Austin units=imperial</call>
<call>search_products query=earbuds max_results=5</call>

Do NOT use JSON format.`,
  },
  systemLevel: {
    name: 'System-Level',
    system: `When calling tools, use this compact format:
<call>tool_name param1=value1 param2=value2</call>

Always use <call>...</call> for tool calls. Never use JSON.`,
    instruction: null,
  },
};

// ── Test prompts (1-6, the proven ones) ──────────────

const testPrompts = [
  { id: 1, text: 'What is the weather in Austin?', expectCompact: true },
  { id: 2, text: 'Search for wireless earbuds.', expectCompact: true },
  { id: 3, text: 'Calculate 29.99 * 1.08', expectCompact: true },
  { id: 4, text: 'What is the weather in Tokyo and London? Use metric units for both.', expectCompact: true },
  { id: 5, text: 'Search for running shoes, max 5 results, in stock only.', expectCompact: true },
  { id: 6, text: 'Get the weather in Austin and Dallas, then calculate the average temperature.', expectCompact: true },
];

// ── Test runner ──────────────────────────────────────

async function runTest(client: Anthropic, variant: string, variantConfig: any, prompt: string): Promise<{
  variant: string;
  prompt: string;
  outputFormat: 'compact' | 'native' | 'none';
  outputTokens: number;
  compactCalls: number;
  nativeCalls: number;
  responsePreview: string;
}> {
  try {
    const messages: any[] = [
      { role: 'user', content: variantConfig.instruction ? (variantConfig.instruction + '\n\n' + prompt) : prompt }
    ];

    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      tools: tools as any,
      system: variantConfig.system || undefined,
      messages,
    } as any);

    // Safety checks on response
    if (!response || typeof response !== 'object') {
      throw new Error('Invalid response: not an object');
    }
    if (!response.content || !Array.isArray(response.content)) {
      throw new Error('Invalid response: content is not an array');
    }
    if (!response.usage || typeof response.usage !== 'object') {
      throw new Error('Invalid response: usage missing');
    }

    // Extract text content
    const textContent = response.content
      .filter((b: any) => b && b.type === 'text')
      .map((b: any) => (b && b.text) || '')
      .join('\n');

    // Check for compact format calls
    const compactCallSpans = findCallSpans(textContent);
    const compactCalls = compactCallSpans ? compactCallSpans.length : 0;

    // Check for native tool_use blocks
    const toolUseBlocks = response.content.filter((b: any) => b && b.type === 'tool_use') || [];
    const nativeCalls = toolUseBlocks.length;

    const outputFormat = compactCalls > 0 ? 'compact' : (nativeCalls > 0 ? 'native' : 'none');

    // Get response preview (first 60 chars of text)
    const preview = textContent.slice(0, 60).replace(/\n/g, ' ');

    return {
      variant,
      prompt: prompt.slice(0, 40),
      outputFormat,
      outputTokens: response.usage.output_tokens || 0,
      compactCalls,
      nativeCalls,
      responsePreview: preview,
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error('    Exception:', errorMsg);
    return {
      variant,
      prompt: prompt.slice(0, 40),
      outputFormat: 'none',
      outputTokens: 0,
      compactCalls: 0,
      nativeCalls: 0,
      responsePreview: 'ERROR: ' + errorMsg.slice(0, 40),
    };
  }
}

// ── Main ─────────────────────────────────────────────

async function main() {
  const client = new Anthropic({ apiKey });

  console.log('');
  console.log('  ' + '='.repeat(80));
  console.log('    A/B Test: Format Instructions for Compact Tool Calling');
  console.log('    Model: ' + MODEL);
  console.log('    4 variants × 6 prompts = 24 API calls');
  console.log('  ' + '='.repeat(80));
  console.log('');

  const allResults: any[] = [];

  for (const [variantKey, variantConfig] of Object.entries(variants)) {
    console.log('  ' + variantConfig.name.padEnd(16) + (variantConfig.system ? '[system msg]' : '[user msg]').padEnd(15));
    console.log('  ' + '─'.repeat(80));

    const variantResults = [];

    for (const prompt of testPrompts) {
      process.stdout.write('    [' + String(prompt.id).padStart(2) + '] ' + prompt.text.slice(0, 50).padEnd(52));

      const result = await runTest(client, variantConfig.name, variantConfig, prompt.text);
      variantResults.push(result);
      allResults.push(result);

      const formatIcon = result.outputFormat === 'compact' ? '◊' : (result.outputFormat === 'native' ? '●' : '○');
      const formatLabel = result.outputFormat.padEnd(7);
      const callsLabel = 'compact:' + String(result.compactCalls).padStart(2) + ' native:' + String(result.nativeCalls).padStart(2);
      const tokLabel = String(result.outputTokens).padStart(4) + ' tok';

      console.log(formatIcon + ' ' + formatLabel + callsLabel.padStart(20) + '  ' + tokLabel);
    }

    // Variant summary
    const compactCount = variantResults.filter(r => r.outputFormat === 'compact').length;
    const nativeCount = variantResults.filter(r => r.outputFormat === 'native').length;
    const noneCount = variantResults.filter(r => r.outputFormat === 'none').length;
    const avgOut = variantResults.reduce((a, r) => a + r.outputTokens, 0) / variantResults.length;

    console.log('  ' + '─'.repeat(80));
    console.log('  SUMMARY:  Compact: ' + String(compactCount).padStart(2) + '/6  Native: ' + String(nativeCount).padStart(2) + '/6  Error: ' + String(noneCount).padStart(2) + '/6  | Avg output: ' + Math.round(avgOut) + ' tok');
    console.log('');
  }

  // Final comparison
  console.log('  ' + '='.repeat(80));
  console.log('    FINAL RESULTS');
  console.log('  ' + '='.repeat(80));
  console.log('');

  for (const [variantKey, variantConfig] of Object.entries(variants)) {
    const variantResults = allResults.filter(r => r.variant === variantConfig.name);
    const compactCount = variantResults.filter(r => r.outputFormat === 'compact').length;
    const nativeCount = variantResults.filter(r => r.outputFormat === 'native').length;
    const avgOut = variantResults.filter(r => r.outputFormat !== 'none').reduce((a, r) => a + r.outputTokens, 0) / Math.max(1, variantResults.filter(r => r.outputFormat !== 'none').length);

    const compactRate = ((compactCount / 6) * 100).toFixed(0);
    const placement = variantConfig.system ? 'system' : 'user';

    console.log('  ' + variantConfig.name.padEnd(16) + 'Compact: ' + String(compactCount).padStart(2) + '/6 (' + compactRate.padStart(3) + '%)  Native: ' + String(nativeCount).padStart(2) + '/6  Avg out: ' + Math.round(avgOut) + ' tok  [' + placement + ']');
  }

  console.log('');

  // Winner
  const variantScores = Object.entries(variants).map(([key, cfg]) => {
    const variantResults = allResults.filter(r => r.variant === cfg.name);
    const compactCount = variantResults.filter(r => r.outputFormat === 'compact').length;
    return { name: cfg.name, compactCount };
  });

  const winner = variantScores.reduce((best, curr) => curr.compactCount > best.compactCount ? curr : best);
  console.log('  🏆 Winner: ' + winner.name + ' (' + winner.compactCount + '/6 compact adoption)');
  console.log('');
}

await main();
