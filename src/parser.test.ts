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

// ── Tool plans used across tests ──────────────────────────────

const plans: ToolPlan[] = [
  {
    name: 'getWeather',
    description: 'Get current weather',
    signature: 'getWeather: location, units?',
    encoding: 'wire',
    fields: [
      { name: 'location', required: true, type: 'string' },
      { name: 'units', required: false, type: 'string' },
    ],
    inputSchema: {},
  },
  {
    name: 'calculate',
    description: 'Evaluate math expression',
    signature: 'calculate: expression',
    encoding: 'wire',
    fields: [{ name: 'expression', required: true, type: 'string' }],
    inputSchema: {},
  },
];

// ═══════════════════════════════════════════════════════════════
//  Span finding — <call> and <tool_result>
// ═══════════════════════════════════════════════════════════════

describe('findCallSpans', () => {
  test('finds a single <call> in text', () => {
    const spans = findCallSpans('<call>getWeather location=Austin</call>');
    expect(spans).toHaveLength(1);
    expect(spans[0]!.body).toBe('getWeather location=Austin');
  });

  test('finds multiple <call> spans', () => {
    expect(findCallSpans('<call>a</call> and <call>b</call>')).toHaveLength(2);
  });

  test('returns empty when no spans exist', () => {
    expect(findCallSpans('plain text')).toHaveLength(0);
  });

  test('handles < inside quoted args (not a tag)', () => {
    const spans = findCallSpans('<call>search query="x<y"</call>');
    expect(spans).toHaveLength(1);
  });
});

describe('findToolResultSpans', () => {
  test('finds a single <tool_result> with name', () => {
    const spans = findToolResultSpans('<tool_result name="get_weather">location=Austin</tool_result>');
    expect(spans).toHaveLength(1);
    expect(spans[0]!.toolName).toBe('get_weather');
    expect(spans[0]!.body).toBe('location=Austin');
  });

  test('finds multiple <tool_result> spans', () => {
    const text = '<tool_result name="a">x=1</tool_result><tool_result name="b">y=2</tool_result>';
    expect(findToolResultSpans(text)).toHaveLength(2);
  });

  test('returns empty for text without tool_result tags', () => {
    expect(findToolResultSpans('no results')).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════
//  Name/body splitting
// ═══════════════════════════════════════════════════════════════

describe('splitNameAndBody', () => {
  test('splits tool name from key=value args', () => {
    const { toolName, argsBody } = splitNameAndBody('getWeather location=Austin units=metric');
    expect(toolName).toBe('getWeather');
    expect(argsBody).toBe('location=Austin units=metric');
  });

  test('handles tool name with no args', () => {
    expect(splitNameAndBody('noop')).toEqual({ toolName: 'noop', argsBody: '' });
  });

  test('trims leading whitespace from args', () => {
    const { argsBody } = splitNameAndBody('tool   key=val');
    expect(argsBody).toBe('key=val');
  });
});

// ═══════════════════════════════════════════════════════════════
//  Wire format tokenizer
// ═══════════════════════════════════════════════════════════════

describe('tokenizeWire', () => {
  test('splits key=value pairs on whitespace', () => {
    expect(tokenizeWire('a=1 b=2 c=3')).toEqual(['a=1', 'b=2', 'c=3']);
  });

  test('preserves quoted values as single tokens', () => {
    expect(tokenizeWire('a="hello world" b=3')).toEqual(['a="hello world"', 'b=3']);
  });

  test('handles single quotes', () => {
    expect(tokenizeWire("a='hello world'")).toEqual(["a='hello world'"]);
  });
});

// ═══════════════════════════════════════════════════════════════
//  Value coercion
// ═══════════════════════════════════════════════════════════════

describe('coerceValue', () => {
  test('booleans', () => {
    expect(coerceValue('true', 'boolean')).toBe(true);
    expect(coerceValue('false', 'boolean')).toBe(false);
  });

  test('integers', () => {
    expect(coerceValue('42', 'int')).toBe(42);
    expect(coerceValue('0', 'int')).toBe(0);
    expect(coerceValue('-5', 'int')).toBe(-5);
  });

  test('floats', () => {
    expect(coerceValue('3.14', 'number')).toBe(3.14);
  });

  test('strings without special chars stay bare', () => {
    expect(coerceValue('Austin', 'string')).toBe('Austin');
  });

  test('quoted strings are unquoted', () => {
    expect(coerceValue('"hello world"', 'string')).toBe('hello world');
  });

  test('JSON array literals', () => {
    expect(coerceValue('["a","b"]', 'string[]')).toEqual(['a', 'b']);
  });

  test('null keyword', () => {
    expect(coerceValue('null', 'string')).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════
//  Wire body parsing (key=value → structured object)
// ═══════════════════════════════════════════════════════════════

describe('parseWireBody', () => {
  test('parses flat key=value pairs', () => {
    const result = parseWireBody('location=Austin units=metric', plans[0]!);
    expect(result).toEqual({ location: 'Austin', units: 'metric' });
  });

  test('throws on token without = sign', () => {
    expect(() => parseWireBody('badtoken', plans[0]!)).toThrow(ToolReduceParseError);
  });

  test('returns empty object for empty body', () => {
    expect(parseWireBody('', plans[0]!)).toEqual({});
  });
});

// ═══════════════════════════════════════════════════════════════
//  Nested object reconstruction (dot paths)
// ═══════════════════════════════════════════════════════════════

describe('reconstructNested', () => {
  test('flat keys stay flat', () => {
    expect(reconstructNested({ a: '1', b: '2' })).toEqual({ a: '1', b: '2' });
  });

  test('dot paths become nested objects', () => {
    expect(reconstructNested({ 'profile.name': 'Alice', 'profile.age': '30' }))
      .toEqual({ profile: { name: 'Alice', age: '30' } });
  });
});

// ═══════════════════════════════════════════════════════════════
//  Full parse pipeline (finds spans + decodes args)
// ═══════════════════════════════════════════════════════════════

describe('parseCompactCalls', () => {
  test('<call> format decodes to structured args', () => {
    const calls = parseCompactCalls('<call>getWeather location=Austin units=metric</call>', plans);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.toolName).toBe('getWeather');
    expect(JSON.parse(calls[0]!.input)).toEqual({ location: 'Austin', units: 'metric' });
  });

  test('<tool_result> format decodes to structured args', () => {
    const calls = parseCompactCalls('<tool_result name="getWeather">location=Austin units=metric</tool_result>', plans);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.toolName).toBe('getWeather');
  });

  test('both formats in the same text', () => {
    const text = '<call>getWeather location=Austin</call> <tool_result name="calculate">expression="2+2"</tool_result>';
    expect(parseCompactCalls(text, plans)).toHaveLength(2);
  });

  test('ignores unknown tools', () => {
    expect(parseCompactCalls('<call>unknownTool x=1</call>', plans)).toHaveLength(0);
  });

  test('empty text returns empty', () => {
    expect(parseCompactCalls('', plans)).toHaveLength(0);
  });

  test('text without any compact calls returns empty', () => {
    expect(parseCompactCalls('just regular prose', plans)).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════
//  Error handling
// ═══════════════════════════════════════════════════════════════

describe('ToolReduceParseError', () => {
  test('has correct name and message', () => {
    const err = new ToolReduceParseError('test error', { toolName: 'foo' });
    expect(err.name).toBe('ToolReduceParseError');
    expect(err.message).toBe('test error');
    expect(err.details.toolName).toBe('foo');
  });
});
