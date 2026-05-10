import { describe, test, expect } from 'bun:test';
import { transformStream } from './stream.ts';
import type { ToolPlan, SSEEvent } from './types.ts';

// ═══════════════════════════════════════════════════════════════
//  Helpers
// ═══════════════════════════════════════════════════════════════

/** Collect all events from an async iterable into an array. */
async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) {
    out.push(item);
  }
  return out;
}

/** Extract only the events of a given type from the output. */
function filterEvents<T extends SSEEvent>(events: SSEEvent[], type: T['type']): T[] {
  return events.filter(e => e.type === type) as T[];
}

// ═══════════════════════════════════════════════════════════════
//  Shared test fixtures
// ═══════════════════════════════════════════════════════════════

const weatherPlan: ToolPlan = {
  name: 'getWeather',
  description: 'Get weather',
  signature: 'getWeather: location, units?',
  encoding: 'wire',
  fields: [
    { name: 'location', required: true, type: 'string' },
    { name: 'units', required: false, type: 'string' },
  ],
  inputSchema: {},
};

const plans: ToolPlan[] = [weatherPlan];

// ==============================================================
//  Passthrough — no transformation needed
// ==============================================================

describe('transformStream', () => {
  test('passes through events unchanged when no plans are given', async () => {
    const input: SSEEvent[] = [
      { type: 'message_start', message: {} },
      { type: 'message_stop' },
    ];
    async function* gen() { yield* input; }

    const output = await collect(transformStream(gen(), []));

    expect(output).toEqual(input);
  });

  test('passes through non-text content blocks unchanged', async () => {
    const input: SSEEvent[] = [
      { type: 'message_start', message: {} },
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_1', name: 'getWeather', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"location":"Austin"}' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 10 } },
      { type: 'message_stop' },
    ];
    async function* gen() { yield* input; }

    const output = await collect(transformStream(gen(), plans));

    expect(output).toHaveLength(input.length);
    expect(output[1]).toEqual(input[1]);
    expect(output[2]).toEqual(input[2]);
  });

  test('passes through text deltas that do not contain compact calls', async () => {
    const input: SSEEvent[] = [
      { type: 'message_start', message: {} },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello, this is plain text.' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
      { type: 'message_stop' },
    ];
    async function* gen() { yield* input; }

    const output = await collect(transformStream(gen(), plans));

    expect(output).toHaveLength(input.length);
  });

  // ==============================================================
  //  <call> → synthetic tool_use conversion
  // ==============================================================

  test('converts a complete <call> in text delta to synthetic tool_use events', async () => {
    const callText = '<call>getWeather location=Austin units=metric</call>';

    async function* gen(): AsyncIterable<SSEEvent> {
      yield { type: 'message_start', message: {} };
      yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
      yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: callText } };
      yield { type: 'content_block_stop', index: 0 };
      yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 10 } };
      yield { type: 'message_stop' };
    }

    const output = await collect(transformStream(gen(), plans));

    // Synthetic tool_use events should have been emitted
    const toolUseStarts = filterEvents(output, 'content_block_start')
      .filter(e => e.content_block.type === 'tool_use');
    expect(toolUseStarts).toHaveLength(1);
    expect(toolUseStarts[0].content_block.name).toBe('getWeather');

    // stop_reason should be overridden to 'tool_use'
    const deltaEvent = filterEvents(output, 'message_delta')[0]!;
    expect(deltaEvent.delta.stop_reason).toBe('tool_use');
  });

  test('converts a <tool_result> in text delta to synthetic tool_use events', async () => {
    const resultText = '<tool_result name="getWeather">location=Austin</tool_result>';

    async function* gen(): AsyncIterable<SSEEvent> {
      yield { type: 'message_start', message: {} };
      yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
      yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: resultText } };
      yield { type: 'content_block_stop', index: 0 };
      yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } };
      yield { type: 'message_stop' };
    }

    const output = await collect(transformStream(gen(), plans));

    const toolUseStarts = filterEvents(output, 'content_block_start')
      .filter(e => e.content_block.type === 'tool_use');
    expect(toolUseStarts).toHaveLength(1);
    expect(toolUseStarts[0].content_block.name).toBe('getWeather');
  });

  test('accumulates partial deltas and emits tool_use once the call completes', async () => {
    // Simulates streaming: <call> arrives across 3 separate deltas.
    // The stream should emit early partials as text, then convert once complete.
    async function* gen(): AsyncIterable<SSEEvent> {
      yield { type: 'message_start', message: {} };
      yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };

      // Delta 1: incomplete opening
      yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '<cal' } };

      // Delta 2: more content but still no closing tag
      yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'l>getWeather location=Austin</cal' } };

      // Delta 3: completes the call
      yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'l>' } };

      yield { type: 'content_block_stop', index: 0 };
      yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 10 } };
      yield { type: 'message_stop' };
    }

    const output = await collect(transformStream(gen(), plans));

    // Should eventually produce a synthetic tool_use
    const toolUseStarts = filterEvents(output, 'content_block_start')
      .filter(e => e.content_block.type === 'tool_use');
    expect(toolUseStarts).toHaveLength(1);
    expect(toolUseStarts[0].content_block.name).toBe('getWeather');

    // stop_reason should be overridden to 'tool_use'
    const msgDelta = filterEvents(output, 'message_delta')[0]!;
    expect(msgDelta.delta.stop_reason).toBe('tool_use');
  });

  // ==============================================================
  //  Mixed content and edge cases
  // ==============================================================

  test('preserves text before and after a <call> in the same content block', async () => {
    async function* gen(): AsyncIterable<SSEEvent> {
      yield { type: 'message_start', message: {} };
      yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
      yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'The weather is: ' } };
      yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '<call>getWeather location=Austin</call>' } };
      yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' Hope that helps!' } };
      yield { type: 'content_block_stop', index: 0 };
      yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 15 } };
      yield { type: 'message_stop' };
    }

    const output = await collect(transformStream(gen(), plans));

    const toolUseStarts = filterEvents(output, 'content_block_start')
      .filter(e => e.content_block.type === 'tool_use');
    expect(toolUseStarts).toHaveLength(1);

    const textDeltas = filterEvents(output, 'content_block_delta')
      .filter(e => e.delta.type === 'text_delta');
    const allText = textDeltas.map(d => d.delta.text).join('');
    expect(allText).toContain('The weather is:');
    expect(allText).toContain('Hope that helps!');
  });

  test('ignores unknown tool names in compact calls', async () => {
    async function* gen(): AsyncIterable<SSEEvent> {
      yield { type: 'message_start', message: {} };
      yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
      yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '<call>unknownTool x=1</call>' } };
      yield { type: 'content_block_stop', index: 0 };
      yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } };
      yield { type: 'message_stop' };
    }

    const output = await collect(transformStream(gen(), plans));

    const toolUseStarts = filterEvents(output, 'content_block_start')
      .filter(e => e.content_block.type === 'tool_use');
    expect(toolUseStarts).toHaveLength(0);
  });

  test('handles multiple compact calls in the same content block', async () => {
    async function* gen(): AsyncIterable<SSEEvent> {
      yield { type: 'message_start', message: {} };
      yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
      yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '<call>getWeather location=Austin</call><call>getWeather location=Houston</call>' } };
      yield { type: 'content_block_stop', index: 0 };
      yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 10 } };
      yield { type: 'message_stop' };
    }

    const output = await collect(transformStream(gen(), plans));

    const toolUseStarts = filterEvents(output, 'content_block_start')
      .filter(e => e.content_block.type === 'tool_use');
    expect(toolUseStarts).toHaveLength(2);
  });

  test('resets state on message_start', async () => {
    async function* gen(): AsyncIterable<SSEEvent> {
      // First message: plain text, no compact calls
      yield { type: 'message_start', message: {} };
      yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
      yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'first' } };
      yield { type: 'content_block_stop', index: 0 };
      yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } };
      yield { type: 'message_stop' };

      // Second message: contains a compact call
      yield { type: 'message_start', message: {} };
      yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
      yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '<call>getWeather location=Austin</call>' } };
      yield { type: 'content_block_stop', index: 0 };
      yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } };
      yield { type: 'message_stop' };
    }

    const output = await collect(transformStream(gen(), plans));

    const toolUseStarts = filterEvents(output, 'content_block_start')
      .filter(e => e.content_block.type === 'tool_use');
    expect(toolUseStarts).toHaveLength(1); // only second message
  });
});
