import { describe, test, expect } from 'bun:test';
import {
  findCallSpans,
  findToolResultSpans,
  parseCompactCalls,
  parseWireBody,
  tokenizeWire,
  coerceValue,
  splitNameAndBody,
  reconstructNested,
  ToolReduceParseError,
} from './parser.ts';
import type { ToolPlan } from './types.ts';

// ═══════════════════════════════════════════════════════════════
//  Shared test fixtures
// ═══════════════════════════════════════════════════════════════

const weatherPlan: ToolPlan = {
  name: 'getWeather',
  description: 'Get current weather',
  signature: 'getWeather: location, units?',
  encoding: 'wire',
  fields: [
    { name: 'location', required: true, type: 'string' },
    { name: 'units', required: false, type: 'string' },
  ],
  inputSchema: {},
};

const calculatePlan: ToolPlan = {
  name: 'calculate',
  description: 'Evaluate math expression',
  signature: 'calculate: expression',
  encoding: 'wire',
  fields: [{ name: 'expression', required: true, type: 'string' }],
  inputSchema: {},
};

const nestedPlan: ToolPlan = {
  name: 'updateProfile',
  description: 'Update user profile',
  signature: 'updateProfile: profile.name, profile.age?',
  encoding: 'wire',
  fields: [
    { name: 'profile.name', required: true, type: 'string' },
    { name: 'profile.age', required: false, type: 'int' },
  ],
  inputSchema: {},
};

const plans = [weatherPlan, calculatePlan, nestedPlan];

// ==============================================================
//  Span finding — <call> and <tool_result>
// ==============================================================

describe('findCallSpans', () => {
  test('extracts a single <call> with its body', () => {
    const text = '<call>getWeather location=Austin</call>';
    const spans = findCallSpans(text);
    expect(spans).toHaveLength(1);
    expect(spans[0]!.start).toBe(0);
    expect(spans[0]!.end).toBe(text.length);
    expect(spans[0]!.body).toBe('getWeather location=Austin');
  });

  test('extracts multiple <call> spans from the same text', () => {
    const spans = findCallSpans('<call>a</call> and <call>b</call>');
    expect(spans).toHaveLength(2);
    expect(spans[0]!.body).toBe('a');
    expect(spans[1]!.body).toBe('b');
  });

  test('returns empty array when the text has no <call> tags', () => {
    expect(findCallSpans('just some plain text')).toHaveLength(0);
  });

  test('treats < inside a quoted value as literal content, not a new tag', () => {
    const text = '<call>search query="x<y"</call>';
    const spans = findCallSpans(text);
    expect(spans).toHaveLength(1);
    expect(spans[0]!.body).toBe('search query="x<y"');
  });

  test('returns nothing for an unclosed <call> tag', () => {
    const spans = findCallSpans('<call>opened but never closed');
    expect(spans).toHaveLength(0);
  });

  test('returns no spans for an empty string', () => {
    expect(findCallSpans('')).toHaveLength(0);
  });

  test('ignores partial <call matches without >', () => {
    const spans = findCallSpans('some <call stuff here');
    expect(spans).toHaveLength(0);
  });
});

describe('findToolResultSpans', () => {
  test('extracts a single <tool_result> with its name attribute and body', () => {
    const text = '<tool_result name="get_weather">location=Austin</tool_result>';
    const spans = findToolResultSpans(text);
    expect(spans).toHaveLength(1);
    expect(spans[0]!.toolName).toBe('get_weather');
    expect(spans[0]!.body).toBe('location=Austin');
    expect(spans[0]!.start).toBe(0);
    expect(spans[0]!.end).toBe(text.length);
  });

  test('extracts multiple <tool_result> spans from the same text', () => {
    const text = '<tool_result name="a">x=1</tool_result><tool_result name="b">y=2</tool_result>';
    const spans = findToolResultSpans(text);
    expect(spans).toHaveLength(2);
    expect(spans[0]!.toolName).toBe('a');
    expect(spans[1]!.toolName).toBe('b');
  });

  test('returns empty array when the text has no <tool_result> tags', () => {
    expect(findToolResultSpans('no results here')).toHaveLength(0);
  });

  test('returns empty array for an empty string', () => {
    expect(findToolResultSpans('')).toHaveLength(0);
  });

  test('ignores malformed <tool_result> without a name attribute', () => {
    const spans = findToolResultSpans('<tool_result>body</tool_result>');
    expect(spans).toHaveLength(0);
  });
});

// ==============================================================
//  Name / body splitting
// ==============================================================

describe('splitNameAndBody', () => {
  test('splits a tool name from its key=value arguments', () => {
    const { toolName, argsBody } = splitNameAndBody('getWeather location=Austin units=metric');
    expect(toolName).toBe('getWeather');
    expect(argsBody).toBe('location=Austin units=metric');
  });

  test('returns empty argsBody when the tool call has no arguments', () => {
    expect(splitNameAndBody('noop')).toEqual({ toolName: 'noop', argsBody: '' });
  });

  test('trims leading whitespace between tool name and first argument', () => {
    const { toolName, argsBody } = splitNameAndBody('tool    key=val');
    expect(toolName).toBe('tool');
    expect(argsBody).toBe('key=val');
  });

  test('handles tool name followed by only whitespace with no args', () => {
    const { toolName, argsBody } = splitNameAndBody('tool   ');
    expect(toolName).toBe('tool');
    expect(argsBody).toBe('');
  });

  test('handles an empty body string', () => {
    const { toolName, argsBody } = splitNameAndBody('');
    expect(toolName).toBe('');
    expect(argsBody).toBe('');
  });
});

// ==============================================================
//  Wire-format tokenizer
// ==============================================================

describe('tokenizeWire', () => {
  test('splits key=value pairs on whitespace boundaries', () => {
    expect(tokenizeWire('a=1 b=2 c=3')).toEqual(['a=1', 'b=2', 'c=3']);
  });

  test('preserves double-quoted values as a single token', () => {
    expect(tokenizeWire('a="hello world" b=3')).toEqual(['a="hello world"', 'b=3']);
  });

  test('preserves single-quoted values as a single token', () => {
    expect(tokenizeWire("a='hello world'")).toEqual(["a='hello world'"]);
  });

  test('handles nested quotes by preserving the quoted token', () => {
    const tokens = tokenizeWire('a="x<y" b=normal');
    expect(tokens).toHaveLength(2);
    expect(tokens[0]).toBe('a="x<y"');
  });

  test('returns an empty array for an empty input', () => {
    expect(tokenizeWire('')).toEqual([]);
  });

  test('handles input with only whitespace', () => {
    expect(tokenizeWire('   ')).toEqual([]);
  });
});

// ==============================================================
//  Value coercion
// ==============================================================

describe('coerceValue', () => {
  test.each([
    { raw: 'true', type: 'boolean', expected: true },
    { raw: 'false', type: 'boolean', expected: false },
    { raw: '42', type: 'int', expected: 42 },
    { raw: '0', type: 'int', expected: 0 },
    { raw: '-5', type: 'int', expected: -5 },
    { raw: '3.14', type: 'number', expected: 3.14 },
    { raw: '-0.5', type: 'number', expected: -0.5 },
  ])('coerces "$raw" with type "$type" to $expected', ({ raw, type, expected }) => {
    expect(coerceValue(raw, type)).toBe(expected);
  });

  test('returns bare string values unchanged when type is "string"', () => {
    expect(coerceValue('Austin', 'string')).toBe('Austin');
  });

  test.each([
    { raw: '"hello world"', expected: 'hello world' },
    { raw: "'hello world'", expected: 'hello world' },
  ])('unquotes $raw → $expected', ({ raw, expected }) => {
    expect(coerceValue(raw, 'string')).toBe(expected);
  });

  test('parses JSON array literals into JS arrays', () => {
    expect(coerceValue('["a","b"]', 'string[]')).toEqual(['a', 'b']);
    expect(coerceValue('["a","b"]', 'string')).toEqual(['a', 'b']);
  });

  test.each([
    { type: 'string' as const, desc: '"string" — kept as literal', expected: 'null' },
    { type: undefined as string | undefined, desc: 'undefined — null keyword', expected: null },
    { type: 'int' as const, desc: '"int" — null keyword', expected: null },
  ])('coerces "null" with type $desc', ({ type, expected }) => {
    expect(coerceValue('null', type)).toBe(expected);
  });

  test('coerces empty double-quoted string to empty string', () => {
    expect(coerceValue('""', 'string')).toBe('');
  });
});

// ==============================================================
//  Wire body parsing (key=value → structured object)
// ==============================================================

describe('parseWireBody', () => {
  test('parses flat key=value pairs into a structured object', () => {
    const result = parseWireBody('location=Austin units=metric', weatherPlan);
    expect(result).toEqual({ location: 'Austin', units: 'metric' });
  });

  test('throws ToolReduceParseError when a token lacks an = sign', () => {
    expect(() => parseWireBody('badtoken', weatherPlan)).toThrow(ToolReduceParseError);
  });

  test('returns an empty object for an empty body string', () => {
    expect(parseWireBody('', weatherPlan)).toEqual({});
  });

  test('coerces int and boolean values according to the plan field types', () => {
    const plan: ToolPlan = {
      name: 'track',
      description: '',
      signature: '',
      encoding: 'wire',
      fields: [
        { name: 'count', required: true, type: 'int' },
        { name: 'active', required: false, type: 'boolean' },
      ],
      inputSchema: {},
    };
    const result = parseWireBody('count=42 active=true', plan);
    expect(result).toEqual({ count: 42, active: true });
  });
});

// ==============================================================
//  Nested-object reconstruction (dot paths → nested objects)
// ==============================================================

describe('reconstructNested', () => {
  test('leaves flat keys without dots as-is', () => {
    expect(reconstructNested({ a: '1', b: '2' })).toEqual({ a: '1', b: '2' });
  });

  test('builds nested objects from dot-separated paths', () => {
    expect(reconstructNested({ 'profile.name': 'Alice', 'profile.age': '30' }))
      .toEqual({ profile: { name: 'Alice', age: '30' } });
  });

  test('handles deeply nested paths', () => {
    expect(reconstructNested({ 'a.b.c': 'deep' }))
      .toEqual({ a: { b: { c: 'deep' } } });
  });

  test('handles an empty input object', () => {
    expect(reconstructNested({})).toEqual({});
  });

  test('mixes flat and nested keys together', () => {
    expect(reconstructNested({ id: '1', 'user.name': 'Alice', 'user.email': 'a@x.com' }))
      .toEqual({ id: '1', user: { name: 'Alice', email: 'a@x.com' } });
  });
});

// ==============================================================
//  Full parse pipeline
// ==============================================================

describe('parseCompactCalls', () => {
  test('decodes a <call> span into a structured tool call with JSON args', () => {
    const calls = parseCompactCalls('<call>getWeather location=Austin units=metric</call>', plans);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.toolName).toBe('getWeather');
    expect(JSON.parse(calls[0]!.input)).toEqual({ location: 'Austin', units: 'metric' });
    expect(calls[0]!.start).toBe(0);
    expect(calls[0]!.end).toBeGreaterThan(0);
  });

  test('decodes a <tool_result> span into a structured tool call', () => {
    const calls = parseCompactCalls(
      '<tool_result name="getWeather">location=Austin units=metric</tool_result>',
      plans,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.toolName).toBe('getWeather');
  });

  test('handles both <call> and <tool_result> formats in the same text', () => {
    const text = '<call>getWeather location=Austin</call> <tool_result name="calculate">expression="2+2"</tool_result>';
    const calls = parseCompactCalls(text, plans);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.toolName).toBe('getWeather');
    expect(calls[1]!.toolName).toBe('calculate');
  });

  test('ignores calls for tools not present in the plans array', () => {
    const calls = parseCompactCalls('<call>unknownTool x=1</call>', plans);
    expect(calls).toHaveLength(0);
  });

  test('returns empty array for an empty text string', () => {
    expect(parseCompactCalls('', plans)).toHaveLength(0);
  });

  test('returns empty array for plain text with no compact calls', () => {
    expect(parseCompactCalls('just regular prose without any tags', plans)).toHaveLength(0);
  });

  test('reconstructs nested objects from dot-path arguments', () => {
    const calls = parseCompactCalls(
      '<call>updateProfile profile.name=Alice profile.age=30</call>',
      plans,
    );
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0]!.input)).toEqual({ profile: { name: 'Alice', age: 30 } });
  });
});

// ==============================================================
//  Custom error type
// ==============================================================

describe('ToolReduceParseError', () => {
  test('sets the error name to "ToolReduceParseError"', () => {
    const err = new ToolReduceParseError('test error', { toolName: 'foo' });
    expect(err.name).toBe('ToolReduceParseError');
  });

  test('carries the error message passed to the constructor', () => {
    const err = new ToolReduceParseError('test error');
    expect(err.message).toBe('test error');
  });

  test('carries optional tool details for debugging', () => {
    const err = new ToolReduceParseError('bad token', { toolName: 'bar', body: 'x y' });
    expect(err.details.toolName).toBe('bar');
    expect(err.details.body).toBe('x y');
  });

  test('defaults details to an empty object', () => {
    const err = new ToolReduceParseError('oops');
    expect(err.details).toEqual({});
  });
});
