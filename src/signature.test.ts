import { describe, test, expect } from 'bun:test';
import { planTools, renderSignature, generateFormatInstruction } from './signature.ts';
import type { AnthropicTool, ToolPlan } from './types.ts';

// ═══════════════════════════════════════════════════════════════
//  Shared test fixtures
// ═══════════════════════════════════════════════════════════════

const flatSchemaTool: AnthropicTool = {
  name: 'get_weather',
  description: 'Get the current weather for a location',
  input_schema: {
    type: 'object',
    properties: {
      location: { type: 'string', description: 'City name' },
      units: { type: 'string', enum: ['metric', 'imperial'], description: 'Unit system' },
    },
    required: ['location'],
  },
};

const nestedSchemaTool: AnthropicTool = {
  name: 'update_profile',
  description: 'Update user profile fields',
  input_schema: {
    type: 'object',
    properties: {
      profile: {
        type: 'object',
        description: 'Profile data',
        properties: {
          displayName: { type: 'string' },
          age: { type: 'integer' },
        },
        required: ['displayName'],
      },
    },
    required: ['profile'],
  },
};

const complexSchemaTool: AnthropicTool = {
  name: 'complex_tool',
  description: 'Has nested arrays and deep objects',
  input_schema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: { id: { type: 'string' }, name: { type: 'string' } },
        },
      },
    },
    required: ['items'],
  },
};

/** 3-level-deep nesting — exceeds the wire-format depth limit (2), so it gets json encoding. */
const deeplyNestedTool: AnthropicTool = {
  name: 'deep_query',
  description: 'Query with deeply nested filters',
  input_schema: {
    type: 'object',
    properties: {
      filters: {
        type: 'object',
        properties: {
          region: {
            type: 'object',
            properties: {
              subregion: {
                type: 'object',
                properties: {
                  city: { type: 'string' },
                },
              },
            },
          },
        },
      },
    },
  },
};

// ==============================================================
//  Tool planning — assigns encoding per tool
// ==============================================================

describe('planTools', () => {
  test('assigns "wire" encoding to flat primitive-only schemas', () => {
    const plans = planTools([flatSchemaTool]);
    expect(plans).toHaveLength(1);
    expect(plans[0]!.encoding).toBe('wire');
  });

  test('assigns "wire" encoding to nested-object schemas (wire can flatten them)', () => {
    const plans = planTools([nestedSchemaTool]);
    expect(plans).toHaveLength(1);
    expect(plans[0]!.encoding).toBe('wire');
  });

  test('assigns "wire" to schemas with array items containing nested objects', () => {
    const plans = planTools([complexSchemaTool]);
    expect(plans[0]!.encoding).toBe('wire');
  });

  test('assigns "json" encoding when nesting exceeds wire-format depth limit', () => {
    const plans = planTools([deeplyNestedTool]);
    expect(plans).toHaveLength(1);
    expect(plans[0]!.encoding).toBe('json');
  });

  test('returns an empty array when given no tool definitions', () => {
    expect(planTools([])).toEqual([]);
  });

  test('produces a plan with all required fields populated', () => {
    const plans = planTools([flatSchemaTool]);
    const plan = plans[0]!;
    expect(plan.name).toBe('get_weather');
    expect(plan.description).toBe('Get the current weather for a location');
    expect(plan.signature).toBeTruthy();
    expect(plan.fields.length).toBeGreaterThan(0);
    expect(plan.inputSchema).toBe(flatSchemaTool.input_schema);
  });
});

// ==============================================================
//  Signature rendering — one-line compact tool descriptions
// ==============================================================

describe('renderSignature', () => {
  test('includes the tool name and parameter types for wire encoding', () => {
    const sig = renderSignature(flatSchemaTool, 'wire');
    expect(sig).toContain('get_weather');
    expect(sig).toContain('location:string');
    expect(sig).toContain('units?:"metric"|"imperial"');
  });

  test('marks optional parameters with ? suffix', () => {
    const sig = renderSignature(flatSchemaTool, 'wire');
    expect(sig).toContain('units?');
  });

  test('produces a minimal signature for json-encoded tools', () => {
    const sig = renderSignature(complexSchemaTool, 'json');
    expect(sig).toContain('<json>');
    expect(sig).toContain('complex_tool');
  });

  test('includes a one-line description when present', () => {
    const sig = renderSignature(flatSchemaTool, 'wire');
    expect(sig).toContain('Get the current weather');
  });

  test('handles a tool with no properties gracefully', () => {
    const tool: AnthropicTool = {
      name: 'noop',
      description: 'Does nothing',
      input_schema: { type: 'object', properties: {} },
    };
    const sig = renderSignature(tool, 'wire');
    expect(sig).toContain('noop');
    expect(sig).not.toContain('undefined');
  });
});

// ==============================================================
//  Format instruction — system-prompt snippet
// ==============================================================

describe('generateFormatInstruction', () => {
  const plans: ToolPlan[] = [
    {
      name: 'getWeather',
      description: 'Get weather',
      signature: 'getWeather: location, units?',
      encoding: 'wire',
      fields: [],
      inputSchema: {},
    },
  ];

  test('includes compact <call> format syntax when requested', () => {
    const inst = generateFormatInstruction('wire', plans);
    expect(inst).toContain('<call>');
    expect(inst).toContain('getWeather');
  });

  test('includes compact <tool_result> format syntax when requested', () => {
    const inst = generateFormatInstruction('tool_result', plans);
    expect(inst).toContain('<tool_result name=');
  });

  test('still produces available-tools section when given an empty plans array', () => {
    const inst = generateFormatInstruction('wire', []);
    expect(inst).toContain('Available tools');
    expect(inst).not.toContain('getWeather');
  });

  test('includes inline examples for wire-format rules', () => {
    const inst = generateFormatInstruction('wire', plans);
    expect(inst).toContain('key=value');
    expect(inst).toContain('Arrays');
    expect(inst).toContain('Booleans');
  });
});
