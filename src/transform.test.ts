import { describe, test, expect } from 'bun:test';
import { minifyToolDefs, transformRequest, transformResponse } from './transform.ts';
import type { AnthropicTool, ToolPlan, MessagesCreateParams, MessageResponse } from './types.ts';

// ═══════════════════════════════════════════════════════════════
//  Shared test fixtures
// ═══════════════════════════════════════════════════════════════

const weatherTool: AnthropicTool = {
  name: 'get_weather',
  description: 'Get the current weather for a given location',
  input_schema: {
    type: 'object',
    properties: {
      location: { type: 'string', description: 'The city name, e.g. Austin, TX' },
      units: {
        type: 'string',
        enum: ['metric', 'imperial'],
        description: 'Temperature unit system',
      },
    },
    required: ['location'],
  },
};

// ==============================================================
//  minifyToolDefs — strips description from schema properties
// ==============================================================

describe('minifyToolDefs', () => {
  test('strips descriptions from each property while preserving type and enum', () => {
    const minified = minifyToolDefs([weatherTool]);
    const props = (minified[0]!.input_schema as any).properties;

    expect(props.location.type).toBe('string');
    expect(props.location.description).toBeUndefined();

    expect(props.units.type).toBe('string');
    expect(props.units.enum).toEqual(['metric', 'imperial']);
    expect(props.units.description).toBeUndefined();
  });

  test('preserves the required array when present', () => {
    const minified = minifyToolDefs([weatherTool]);
    expect((minified[0]!.input_schema as any).required).toEqual(['location']);
  });

  test('preserves items on array-type properties', () => {
    const tool: AnthropicTool = {
      name: 'invite',
      description: 'Invite users',
      input_schema: {
        type: 'object',
        properties: {
          emails: {
            type: 'array',
            description: 'List of email addresses',
            items: { type: 'string', description: 'An email address' },
          },
        },
      },
    };
    const minified = minifyToolDefs([tool]);
    const prop = (minified[0]!.input_schema as any).properties.emails;
    // items is preserved as-is (minifier strips top-level property fields only)
    expect(prop.items).toEqual({ type: 'string', description: 'An email address' });
  });

  test('returns an empty array when given no tools', () => {
    expect(minifyToolDefs([])).toEqual([]);
  });

  test('preserves tool name and top-level description', () => {
    const minified = minifyToolDefs([weatherTool]);
    expect(minified[0]!.name).toBe('get_weather');
    expect(minified[0]!.description).toBe('Get the current weather for a given location');
  });

  test('handles a tool with no properties gracefully', () => {
    const tool: AnthropicTool = {
      name: 'noop',
      description: 'Does nothing',
      input_schema: { type: 'object' },
    };
    const minified = minifyToolDefs([tool]);
    expect(minified[0]!.name).toBe('noop');
  });

  test('strips verbose fields like examples, title, format, and default', () => {
    const tool: AnthropicTool = {
      name: 'verbose',
      description: 'Verbose tool',
      input_schema: {
        type: 'object',
        properties: {
          age: {
            type: 'integer',
            description: 'Age in years',
            examples: [25],
            title: 'Age',
            format: 'int32',
            default: 0,
          },
        },
      },
    };
    const minified = minifyToolDefs([tool]);
    const prop = (minified[0]!.input_schema as any).properties.age;
    expect(prop.type).toBe('integer');
    expect(prop.description).toBeUndefined();
    expect(prop.examples).toBeUndefined();
    expect(prop.title).toBeUndefined();
    expect(prop.format).toBeUndefined();
    expect(prop.default).toBeUndefined();
  });
});

// ==============================================================
//  transformRequest — prepares params before API call
// ==============================================================

describe('transformRequest', () => {
  const baseParams: MessagesCreateParams = {
    model: 'claude-sonnet-4-5',
    max_tokens: 1024,
    messages: [{ role: 'user', content: 'Weather?' }],
  };

  const options = {
    syntax: 'wire' as const,
    placement: 'first_user' as const,
    rewriteHistory: true,
    minifyToolDefinitions: false,
  };

  test('returns params unchanged and empty plans when there are no tools', () => {
    const { params, plans } = transformRequest(baseParams, options);
    expect(plans).toEqual([]);
    expect(params.tools).toBeUndefined();
  });

  test('injects format instruction into the first user message when syntax=wire', () => {
    const { params } = transformRequest(
      { ...baseParams, tools: [weatherTool] },
      options,
    );
    const firstMsg = params.messages![0];
    expect(typeof firstMsg.content).toBe('string');
    // Format instruction is prepended
    expect((firstMsg.content as string).includes('<call>')).toBe(true);
    expect((firstMsg.content as string).includes('Weather?')).toBe(true);
  });

  test('injects format instruction into system prompt when placement=system', () => {
    const { params } = transformRequest(
      { ...baseParams, system: 'Be helpful.', tools: [weatherTool] },
      { ...options, placement: 'system' },
    );
    // System prompt gets the format instruction appended
    expect(typeof params.system).toBe('string');
    expect((params.system as string).includes('<call>')).toBe(true);
    expect((params.system as string).includes('Be helpful.')).toBe(true);
  });

  test('generates tool plans from the original tool definitions', () => {
    const { plans } = transformRequest(
      { ...baseParams, tools: [weatherTool] },
      options,
    );
    expect(plans).toHaveLength(1);
    expect(plans[0]!.name).toBe('get_weather');
    expect(plans[0]!.encoding).toBe('wire');
  });

  test('minifies tool definitions when minifyToolDefinitions is true', () => {
    const { params } = transformRequest(
      { ...baseParams, tools: [weatherTool] },
      { ...options, minifyToolDefinitions: true },
    );
    const tool = (params.tools as AnthropicTool[])[0]!;
    expect((tool.input_schema as any).properties.location.description).toBeUndefined();
  });

  test('skips minification when minifyToolDefinitions is false', () => {
    const { params } = transformRequest(
      { ...baseParams, tools: [weatherTool] },
      options,
    );
    const tool = (params.tools as AnthropicTool[])[0]!;
    expect((tool.input_schema as any).properties.location.description).toBe('The city name, e.g. Austin, TX');
  });

  test('rewrites history when rewriteHistory is true', () => {
    const params: MessagesCreateParams = {
      ...baseParams,
      tools: [weatherTool],
      messages: [
        { role: 'user', content: 'Weather?' },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'tu_1', name: 'get_weather', input: { location: 'Austin' } },
          ],
        },
        { role: 'user', content: 'Thanks' },
      ],
    };

    const { params: result } = transformRequest(params, options);

    // Assistant message should now be a string (compact format)
    const assistantMsg = result.messages![1]!;
    expect(assistantMsg.role).toBe('assistant');
    expect(typeof assistantMsg.content).toBe('string');
    expect(assistantMsg.content).toContain('<call>get_weather');
  });

  test('skips history rewriting when rewriteHistory is false', () => {
    const assistantContent = [
      { type: 'tool_use', id: 'tu_1', name: 'get_weather', input: { location: 'Austin' } },
    ];
    const params: MessagesCreateParams = {
      ...baseParams,
      tools: [weatherTool],
      messages: [
        { role: 'user', content: 'Weather?' },
        { role: 'assistant', content: assistantContent },
        { role: 'user', content: 'Thanks' },
      ],
    };

    const { params: result } = transformRequest(params, { ...options, rewriteHistory: false });

    // Assistant message should remain as structured content blocks
    const assistantMsg = result.messages![1]!;
    expect(assistantMsg.role).toBe('assistant');
    expect(Array.isArray(assistantMsg.content)).toBe(true);
  });

  test('does not mutate the caller\'s original params object', () => {
    const original = { ...baseParams, tools: [weatherTool] };
    const copy = { ...original, messages: [...original.messages] };
    transformRequest(original, options);
    expect(original).toEqual(copy);
  });
});

// ==============================================================
//  transformResponse — parses compact calls from response text
// ==============================================================

describe('transformResponse', () => {
  const plans: ToolPlan[] = [{
    name: 'get_weather',
    description: 'Get weather',
    signature: '',
    encoding: 'wire',
    fields: [{ name: 'location', required: true, type: 'string' }],
    inputSchema: {},
  }];

  const makeResponse = (content: any[]): MessageResponse => ({
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    content,
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
  });

  test('returns response unchanged when plans are empty', () => {
    const response = makeResponse([{ type: 'text', text: 'Hello!' }]);
    expect(transformResponse(response, [])).toBe(response);
  });

  test('passes through non-text content blocks unchanged', () => {
    const response = makeResponse([
      { type: 'tool_use', id: 'tu_1', name: 'get_weather', input: {} },
    ]);
    const result = transformResponse(response, plans);
    expect(result.content).toHaveLength(1);
    expect(result.content[0]!.type).toBe('tool_use');
  });

  test('passes through thinking blocks unchanged', () => {
    const response = makeResponse([
      { type: 'thinking', thinking: 'Let me think about this...', signature: 'sig_123' },
      { type: 'text', text: 'The weather is nice.' },
    ]);
    const result = transformResponse(response, plans);

    expect(result.content).toHaveLength(2);
    expect(result.content[0]!.type).toBe('thinking');
    expect((result.content[0] as any).thinking).toBe('Let me think about this...');
    expect(result.content[1]!.type).toBe('text');
    expect(result.stop_reason).toBe('end_turn');
  });

  test('converts a text block containing a <call> into a tool_use block', () => {
    const response = makeResponse([
      { type: 'text', text: '<call>get_weather location=Austin</call>' },
    ]);
    const result = transformResponse(response, plans);
    expect(result.content).toHaveLength(1);
    expect(result.content[0]!.type).toBe('tool_use');
    expect((result.content[0] as any).name).toBe('get_weather');
    expect((result.content[0] as any).input).toEqual({ location: 'Austin' });
  });

  test('converts a text block containing a <tool_result> into a tool_use block', () => {
    const response = makeResponse([
      { type: 'text', text: '<tool_result name="get_weather">location=Austin</tool_result>' },
    ]);
    const result = transformResponse(response, plans);
    expect(result.content).toHaveLength(1);
    expect(result.content[0]!.type).toBe('tool_use');
  });

  test('splits text content around compact calls preserving leading/trailing text', () => {
    const response = makeResponse([
      {
        type: 'text',
        text: 'The weather is: <call>get_weather location=Austin</call>. Hope that helps!',
      },
    ]);
    const result = transformResponse(response, plans);
    expect(result.content).toHaveLength(3);
    expect(result.content[0]!.type).toBe('text');
    expect((result.content[0] as any).text).toContain('The weather is:');
    expect(result.content[1]!.type).toBe('tool_use');
    expect(result.content[2]!.type).toBe('text');
    expect((result.content[2] as any).text).toContain('Hope that helps!');
  });

  test('overrides stop_reason to "tool_use" when compact calls are found', () => {
    const response = makeResponse([
      { type: 'text', text: '<call>get_weather location=Austin</call>' },
    ]);
    const result = transformResponse(response, plans);
    expect(result.stop_reason).toBe('tool_use');
  });

  test('preserves original stop_reason when no compact calls are found', () => {
    const response = makeResponse([
      { type: 'text', text: 'Just a plain text response.' },
    ]);
    const result = transformResponse(response, plans);
    expect(result.stop_reason).toBe('end_turn');
  });

  test('handles multiple compact calls in the same text block', () => {
    const response = makeResponse([
      {
        type: 'text',
        text: '<call>get_weather location=Austin</call><call>get_weather location=Houston</call>',
      },
    ]);
    const result = transformResponse(response, plans);
    const toolUses = result.content.filter(c => c.type === 'tool_use');
    expect(toolUses).toHaveLength(2);
  });
});
