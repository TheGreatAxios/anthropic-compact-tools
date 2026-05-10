import { describe, test, expect } from 'bun:test';
import Anthropic from '@anthropic-ai/sdk';
import { CompactAnthropic } from './index.ts';
import type { AnthropicTool, MessageResponse } from './types.ts';

// ═══════════════════════════════════════════════════════════════
//  Shared test fixtures
// ═══════════════════════════════════════════════════════════════

const weatherTool: AnthropicTool = {
  name: 'get_weather',
  description: 'Get weather',
  input_schema: {
    type: 'object',
    properties: { location: { type: 'string' } },
    required: ['location'],
  },
};

// ==============================================================
//  Construction
// ==============================================================

describe('CompactAnthropic', () => {
  test('constructs without arguments', () => {
    const client = new CompactAnthropic();
    expect(client).toBeInstanceOf(CompactAnthropic);
    expect(client.client).toBeDefined();
  });

  test('constructs with an options object', () => {
    const client = new CompactAnthropic({ apiKey: 'sk-test' });
    expect(client).toBeInstanceOf(CompactAnthropic);
    expect(client.client).toBeDefined();
  });

  test('wraps an existing Anthropic instance', () => {
    const inner = new Anthropic({ apiKey: 'sk-test' });
    const client = new CompactAnthropic(inner);
    expect(client.client).toBe(inner);
  });

  test('exposes the underlying Anthropic client via .client', () => {
    const client = new CompactAnthropic({ apiKey: 'sk-test' });
    expect(client.client).toBeDefined();
    expect(typeof client.client.messages).toBe('object');
  });

  test('provides a messages proxy via .messages', () => {
    const client = new CompactAnthropic({ apiKey: 'sk-test' });
    const messages = client.messages;
    expect(messages).toBeDefined();
    expect(typeof messages.create).toBe('function');
  });

  test('provides beta access via .beta', () => {
    const client = new CompactAnthropic({ apiKey: 'sk-test' });
    expect(client.beta).toBeDefined();
  });

  // ==============================================================
  //  messages.create — end-to-end transform pipeline
  // ==============================================================

  test('messages.create transforms request params and response content', async () => {
    // Arrange: create a real Anthropic instance, then stub its messages.create
    const inner = new Anthropic({ apiKey: 'sk-test' });

    let capturedParams: any;
    const fakeResponse: MessageResponse = {
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: '<call>get_weather location=Austin</call>' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5 },
    };

    // Stub before the proxy captures the original create
    inner.messages.create = async (params: any) => {
      capturedParams = params;
      return fakeResponse;
    };

    const client = new CompactAnthropic(inner, { syntax: 'wire' });

    // Act
    const result = await client.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'Weather?' }],
      tools: [weatherTool],
    } as any);

    // Assert: request was transformed (format instruction injected into system prompt)
    expect(capturedParams).toBeDefined();
    expect(capturedParams.system).toContain('# Compact tool calling');

    // Assert: response was transformed (compact text → tool_use block)
    const toolUse = result.content.find((c: any) => c.type === 'tool_use');
    expect(toolUse).toBeDefined();
    expect((toolUse as any).name).toBe('get_weather');
    expect((toolUse as any).input).toEqual({ location: 'Austin' });
    expect(result.stop_reason).toBe('tool_use');
  });

  // ==============================================================
  //  Re-exports
  // ==============================================================

  test('exposes public API via re-exports', async () => {
    const mod = await import('./index.ts');
    expect(mod.ToolReduceParseError).toBeDefined();
    expect(mod.planTools).toBeDefined();
    expect(mod.parseCompactCalls).toBeDefined();
    expect(mod.findCallSpans).toBeDefined();
    expect(mod.serializeCall).toBeDefined();
    expect(mod.serializeToolCall).toBeDefined();
  });
});
