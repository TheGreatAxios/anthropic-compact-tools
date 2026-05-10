import { describe, test, expect } from 'bun:test';
import { serializeCall, serializeToolResultCall, serializeToolCall } from './serialize.ts';
import type { ToolPlan } from './types.ts';

const plan: ToolPlan = {
  name: 'getWeather',
  description: '',
  signature: '',
  encoding: 'wire',
  fields: [{ name: 'location', required: true, type: 'string' }],
  inputSchema: {},
};

// ═══════════════════════════════════════════════════════════════
//  Wire format serialization
// ═══════════════════════════════════════════════════════════════

describe('serializeCall', () => {
  test('produces <call>toolName key=value</call>', () => {
    const result = serializeCall('getWeather', { location: 'Austin' }, plan);
    expect(result).toBe('<call>getWeather location=Austin</call>');
  });

  test('serializes multiple args', () => {
    const result = serializeCall('getWeather', { location: 'Austin', units: 'metric' }, plan);
    expect(result).toBe('<call>getWeather location=Austin units=metric</call>');
  });
});

// ═══════════════════════════════════════════════════════════════
//  Tool result format serialization
// ═══════════════════════════════════════════════════════════════

describe('serializeToolResultCall', () => {
  test('produces <tool_result name="X">key=value</tool_result>', () => {
    const result = serializeToolResultCall('getWeather', { location: 'Austin' }, plan);
    expect(result).toBe('<tool_result name="getWeather">location=Austin</tool_result>');
  });
});

// ═══════════════════════════════════════════════════════════════
//  Unified serializer (syntax parameter)
// ═══════════════════════════════════════════════════════════════

describe('serializeToolCall', () => {
  test('syntax=wire produces same as serializeCall', () => {
    expect(serializeToolCall('getWeather', { location: 'Austin' }, 'wire', plan))
      .toBe('<call>getWeather location=Austin</call>');
  });

  test('syntax=tool_result produces same as serializeToolResultCall', () => {
    expect(serializeToolCall('getWeather', { location: 'Austin' }, 'tool_result', plan))
      .toBe('<tool_result name="getWeather">location=Austin</tool_result>');
  });
});
