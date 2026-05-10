import { describe, test, expect } from 'bun:test';
import { serializeCall, serializeToolResultCall, serializeToolCall, rewriteHistory } from './serialize.ts';
import type { ToolPlan, MessageParam } from './types.ts';

// ═══════════════════════════════════════════════════════════════
//  Shared test fixtures
// ═══════════════════════════════════════════════════════════════

const wirePlan: ToolPlan = {
  name: 'getWeather',
  description: '',
  signature: '',
  encoding: 'wire',
  fields: [
    { name: 'location', required: true, type: 'string' },
    { name: 'units', required: false, type: 'string' },
  ],
  inputSchema: {},
};

const jsonPlan: ToolPlan = {
  name: 'complexOp',
  description: '',
  signature: '',
  encoding: 'json',
  fields: [{ name: 'data', required: true, type: 'string' }],
  inputSchema: {},
};

const plans = [wirePlan];

// ==============================================================
//  serializeCall — <call> format
// ==============================================================

describe('serializeCall', () => {
  test('produces <call>name key=value</call> for a single argument', () => {
    const result = serializeCall('getWeather', { location: 'Austin' }, wirePlan);
    expect(result).toBe('<call>getWeather location=Austin</call>');
  });

  test('serializes multiple arguments separated by spaces', () => {
    const result = serializeCall('getWeather', { location: 'Austin', units: 'metric' }, wirePlan);
    expect(result).toBe('<call>getWeather location=Austin units=metric</call>');
  });

  test('quotes values containing spaces', () => {
    const result = serializeCall('getWeather', { location: 'San Francisco' }, wirePlan);
    expect(result).toBe('<call>getWeather location="San Francisco"</call>');
  });

  test('handles boolean and numeric values', () => {
    const plan: ToolPlan = {
      ...wirePlan,
      fields: [
        { name: 'active', required: true, type: 'boolean' },
        { name: 'count', required: false, type: 'int' },
      ],
    };
    const result = serializeCall('track', { active: true, count: 42 }, plan);
    expect(result).toBe('<call>track active=true count=42</call>');
  });

  test('returns a self-closing tag when args are empty', () => {
    const result = serializeCall('noop', {}, wirePlan);
    expect(result).toBe('<call>noop</call>');
  });

  test('quotes empty-string arguments', () => {
    const plan: ToolPlan = {
      ...wirePlan,
      fields: [{ name: 'message', required: true, type: 'string' }],
    };
    const result = serializeCall('echo', { message: '' }, plan);
    expect(result).toContain('message=""');
  });

  test('serializes array values as JSON inline', () => {
    const plan: ToolPlan = {
      ...wirePlan,
      fields: [{ name: 'tags', required: true, type: 'string[]' }],
    };
    const result = serializeCall('multi', { tags: ['a', 'b', 'c'] }, plan);
    expect(result).toBe('<call>multi tags=["a","b","c"]</call>');
  });

  test('serializes null as the literal "null" keyword', () => {
    const plan: ToolPlan = {
      ...wirePlan,
      fields: [{ name: 'value', required: false, type: 'string' }],
    };
    const result = serializeCall('nullable', { value: null }, plan);
    expect(result).toBe('<call>nullable value=null</call>');
  });

  test('uses single quotes when value contains double quotes', () => {
    const plan: ToolPlan = {
      ...wirePlan,
      fields: [{ name: 'message', required: true, type: 'string' }],
    };
    const result = serializeCall('echo', { message: 'say "hello"' }, plan);
    expect(result).toBe(`<call>echo message='say "hello"'</call>`);
  });
});

// ==============================================================
//  serializeToolResultCall — <tool_result> format
// ==============================================================

describe('serializeToolResultCall', () => {
  test('produces <tool_result name="X">key=value</tool_result> for a single argument', () => {
    const result = serializeToolResultCall('getWeather', { location: 'Austin' }, wirePlan);
    expect(result).toBe('<tool_result name="getWeather">location=Austin</tool_result>');
  });

  test('does not add space between opening tag and value in tool_result format', () => {
    const result = serializeToolResultCall('getWeather', { location: 'Austin', units: 'metric' }, wirePlan);
    expect(result).toBe('<tool_result name="getWeather">location=Austin units=metric</tool_result>');
  });

  test('returns a self-closing tag when args are empty', () => {
    const result = serializeToolResultCall('noop', {}, wirePlan);
    expect(result).toBe('<tool_result name="noop"></tool_result>');
  });
});

// ==============================================================
//  serializeToolCall — unified dispatcher
// ==============================================================

describe('serializeToolCall', () => {
  test('with syntax="wire" produces the same output as serializeCall', () => {
    const result = serializeToolCall('getWeather', { location: 'Austin' }, 'wire', wirePlan);
    expect(result).toBe('<call>getWeather location=Austin</call>');
  });

  test('with syntax="tool_result" produces the same output as serializeToolResultCall', () => {
    const result = serializeToolCall('getWeather', { location: 'Austin' }, 'tool_result', wirePlan);
    expect(result).toBe('<tool_result name="getWeather">location=Austin</tool_result>');
  });

  test('serializes JSON-body for a tool with json encoding', () => {
    const result = serializeToolCall('complexOp', { data: { nested: true } }, 'wire', jsonPlan);
    expect(result).toBe('<call>complexOp{"data":{"nested":true}}</call>');
  });

  test('falls back to JSON serialization when no plan is provided', () => {
    const result = serializeToolCall('unknown', { key: 'val' }, 'wire');
    expect(result).toBe('<call>unknown{"key":"val"}</call>');
  });
});

// ==============================================================
//  rewriteHistory — converts tool_use / tool_result to compact text
// ==============================================================

describe('rewriteHistory', () => {
  test('converts assistant tool_use blocks to compact wire-format text', () => {
    const messages: MessageParam[] = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Checking weather: ' },
          { type: 'tool_use', id: 'tu_1', name: 'getWeather', input: { location: 'Austin' } },
        ],
      },
    ];

    const result = rewriteHistory(messages, plans, 'wire');

    expect(result).toHaveLength(1);
    expect(result[0]!.role).toBe('assistant');
    expect(typeof result[0]!.content).toBe('string');
    expect(result[0]!.content).toContain('Checking weather:');
    expect(result[0]!.content).toContain('<call>getWeather location=Austin</call>');
  });

  test('converts assistant tool_use blocks to compact tool_result format', () => {
    const messages: MessageParam[] = [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tu_1', name: 'getWeather', input: { location: 'Austin' } },
        ],
      },
    ];

    const result = rewriteHistory(messages, plans, 'tool_result');

    expect(typeof result[0]!.content).toBe('string');
    expect(result[0]!.content).toContain('<tool_result name="getWeather">location=Austin</tool_result>');
  });

  test('converts user tool_result blocks to plain text', () => {
    const messages: MessageParam[] = [
      {
        role: 'user',
        content: [
          { type: 'tool_result', content: 'Sunny, 72°F' } as any,
          { type: 'text', text: 'Here you go' } as any,
        ] as any,
      },
    ];

    const result = rewriteHistory(messages, plans, 'wire');

    expect(result).toHaveLength(1);
    expect(result[0]!.role).toBe('user');
    expect(typeof result[0]!.content).toBe('string');
    expect(result[0]!.content).toContain('Here you go');
  });

  test('passes through string-content messages unchanged', () => {
    const messages: MessageParam[] = [
      { role: 'user', content: 'What is the weather?' },
    ];

    const result = rewriteHistory(messages, plans, 'wire');
    expect(result).toEqual(messages);
  });

  test('merges consecutive user messages into one', () => {
    const messages: MessageParam[] = [
      { role: 'user', content: 'First question' },
      { role: 'user', content: 'Second question' },
    ];

    const result = rewriteHistory(messages, plans, 'wire');
    expect(result).toHaveLength(1);
    expect(result[0]!.role).toBe('user');
    expect(typeof result[0]!.content).toBe('string');
    expect(result[0]!.content).toContain('First question');
    expect(result[0]!.content).toContain('Second question');
  });

  test('leaves a multi-turn conversation structurally intact', () => {
    const messages: MessageParam[] = [
      { role: 'user', content: 'Weather?' },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tu_1', name: 'getWeather', input: { location: 'Austin' } },
        ],
      },
      { role: 'user', content: 'Thanks' },
    ];

    const result = rewriteHistory(messages, plans, 'wire');
    expect(result).toHaveLength(3);
    expect(result[0]!.role).toBe('user');
    expect(result[1]!.role).toBe('assistant');
    expect(result[2]!.role).toBe('user');
    expect(typeof result[1]!.content).toBe('string');
    expect(result[1]!.content).toContain('<call>getWeather');
  });
});
