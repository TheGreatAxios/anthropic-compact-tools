import { describe, test, expect } from 'bun:test';
import { planTools, renderSignature, generateFormatInstruction } from './signature.ts';
import type { AnthropicTool, ToolPlan } from './types.ts';

// ═══════════════════════════════════════════════════════════════
//  Tool planning — assigns wire/json encoding per tool
// ═══════════════════════════════════════════════════════════════

describe('planTools', () => {
  test('flat primitive schemas are encoded as wire', () => {
    const tools: AnthropicTool[] = [{
      name: 'get_weather',
      description: 'Get weather',
      input_schema: {
        type: 'object',
        properties: {
          location: { type: 'string' },
          units: { type: 'string', enum: ['metric', 'imperial'] },
        },
        required: ['location'],
      },
    }];
    const plans = planTools(tools);
    expect(plans).toHaveLength(1);
    expect(plans[0]!.encoding).toBe('wire');
  });

  test('schemas with nested objects use wire encoding (flattenable)', () => {
    const tools: AnthropicTool[] = [{
      name: 'complex_tool',
      description: 'Has nested object',
      input_schema: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            items: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' } } },
          },
        },
        required: ['items'],
      },
    }];
    const plans = planTools(tools);
    expect(plans[0]!.encoding).toBe('wire');
  });

  test('handles empty tools array', () => {
    expect(planTools([])).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════
//  Signature rendering — one-line tool descriptions
// ═══════════════════════════════════════════════════════════════

describe('renderSignature', () => {
  test('includes tool name and parameter types', () => {
    const tool: AnthropicTool = {
      name: 'get_weather',
      description: 'Get the weather',
      input_schema: {
        type: 'object',
        properties: { location: { type: 'string' }, units: { type: 'string', enum: ['metric', 'imperial'] } },
        required: ['location'],
      },
    };
    const sig = renderSignature(tool, 'wire');
    expect(sig).toContain('get_weather');
    expect(sig).toContain('location:string');
    expect(sig).toContain('units?:"metric"|"imperial"');
  });

  test('json encoding produces minimal signature', () => {
    const tool: AnthropicTool = {
      name: 'complex',
      description: 'Complex tool',
      input_schema: { type: 'object', properties: { data: { type: 'array', items: {} } } },
    };
    expect(renderSignature(tool, 'json')).toContain('<json>');
  });
});

// ═══════════════════════════════════════════════════════════════
//  Format instruction generation — system prompt snippet
// ═══════════════════════════════════════════════════════════════

describe('generateFormatInstruction', () => {
  const plans: ToolPlan[] = [{ name: 'getWeather', description: 'Get weather', signature: 'getWeather: location, units?', encoding: 'wire', fields: [], inputSchema: {} }];

  test('wire syntax includes <call> format', () => {
    const inst = generateFormatInstruction('wire', plans);
    expect(inst).toContain('<call>');
    expect(inst).toContain('getWeather');
  });

  test('tool_result syntax includes <tool_result> format', () => {
    const inst = generateFormatInstruction('tool_result', plans);
    expect(inst).toContain('<tool_result name=');
  });

  test('empty plans still produce format instructions', () => {
    expect(generateFormatInstruction('wire', [])).toContain('Available tools');
  });
});
