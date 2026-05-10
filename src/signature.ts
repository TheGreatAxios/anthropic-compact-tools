/**
 * Tool signature compiler — generates compact one-line signatures from tool definitions.
 * O(n) on number of tools × avg prop count. Depth-limited to prevent stack blow.
 */

import type { ToolPlan, AnthropicTool } from './types.ts';

const PRIMITIVE_TYPES = new Set(['string', 'number', 'integer', 'boolean']);
const MAX_SCHEMA_DEPTH = 5;

type SchemaNode = {
  type?: string | string[];
  properties?: Record<string, SchemaNode>;
  required?: string[];
  description?: string;
  enum?: unknown[];
  items?: SchemaNode;
  [k: string]: unknown;
};

// ── Schema analysis ──────────────────────────────────────────

/** True if schema is a flat object of primitives (depth 1). */
function isFlat(schema: SchemaNode): boolean {
  return isWireCapable(schema, 1);
}

/** True if schema can be expressed in wire format (primitives, arrays, shallow nested objects). */
function isWireCapable(schema: SchemaNode | undefined, depth = 2): boolean {
  if (!schema || schema.type !== 'object' || !schema.properties) return false;
  return Object.values(schema.properties).every(prop => isWireLeaf(prop, depth));
}

function isWireLeaf(node: SchemaNode, depth: number): boolean {
  if (!node) return false;
  if (typeof node.type === 'string' && PRIMITIVE_TYPES.has(node.type)) return true;
  if (Array.isArray(node.type) && node.type.every(t => PRIMITIVE_TYPES.has(t) || t === 'null')) return true;
  if (Array.isArray(node.enum)) return true;
  if (node.type === 'array' && node.items) return isWireLeaf(node.items, depth);
  if (node.type === 'object' && node.properties && depth > 0) {
    return Object.values(node.properties).every(p => isWireLeaf(p as SchemaNode, depth - 1));
  }
  return false;
}

/** Collect flattened field paths from a nested schema. Depth-limited. */
function collectFlattenedPaths(
  schema: SchemaNode,
  prefix: string,
  topLevelRequired: Set<string>,
  depth = 0,
): Array<{ name: string; required: boolean; type: string }> {
  if (depth > MAX_SCHEMA_DEPTH || !schema.properties) return [];
  const out: Array<{ name: string; required: boolean; type: string }> = [];
  for (const [name, node] of Object.entries(schema.properties)) {
    const key = prefix ? `${prefix}.${name}` : name;
    const required = prefix ? (schema.required ?? []).includes(name) : topLevelRequired.has(name);
    if (node.type === 'object' && node.properties) {
      out.push(...collectFlattenedPaths(node, key, new Set(schema.required ?? []), depth + 1));
    } else {
      out.push({ name: key, required, type: leafTypeLabel(node) });
    }
  }
  return out;
}

// ── Signature rendering ─────────────────────────────────────

export function renderSignature(tool: AnthropicTool, encoding: 'wire' | 'json'): string {
  const schema = tool.input_schema as SchemaNode;
  const desc = tool.description ? ` — ${oneLine(tool.description)}` : '';
  if (encoding === 'json') return `${tool.name}: <json>${desc}`;
  if (!schema?.properties) return `${tool.name}: ()${desc}`;

  const required = new Set(schema.required ?? []);
  const fields = isWireCapable(schema)
    ? collectFlattenedPaths(schema, '', required)
    : Object.entries(schema.properties).map(([name, node]) => ({
        name, required: required.has(name), type: leafTypeLabel(node as SchemaNode),
      }));

  const parts = fields.map(f => `${f.name}${f.required ? '' : '?'}:${f.type}`);
  return `${tool.name}: ${parts.join(', ')}${desc}`;
}

function leafTypeLabel(node: SchemaNode): string {
  if (Array.isArray(node.enum)) return node.enum.map(v => JSON.stringify(v)).join('|');
  if (typeof node.type === 'string') {
    if (node.type === 'integer') return 'int';
    if (node.type === 'array' && node.items) {
      const inner = leafTypeLabel(node.items);
      if (['string', 'int', 'number', 'boolean'].includes(inner)) return `${inner}[]`;
      return `[${inner}]`;
    }
    return node.type;
  }
  if (Array.isArray(node.type)) return node.type.join('|');
  return 'any';
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim().slice(0, 120);
}

// ── Plan builder ─────────────────────────────────────────────

export function planTools(tools: AnthropicTool[]): ToolPlan[] {
  return tools.map(tool => {
    const schema = tool.input_schema as SchemaNode;
    const wireCapable = isWireCapable(schema);
    const encoding: 'wire' | 'json' = wireCapable ? 'wire' : 'json';
    const required = new Set(schema?.required ?? []);

    const fields = wireCapable
      ? (schema?.properties ? collectFlattenedPaths(schema, '', required) : [])
      : (schema?.properties
          ? Object.entries(schema.properties).map(([name, node]) => ({
              name, required: required.has(name), type: leafTypeLabel(node as SchemaNode),
            }))
          : []);

    return {
      name: tool.name,
      description: tool.description,
      signature: renderSignature(tool, encoding),
      encoding,
      fields,
      inputSchema: tool.input_schema,
    };
  });
}

// ── Format instruction generator ─────────────────────────────

export function generateFormatInstruction(syntax: 'wire' | 'tool_result', plans: ToolPlan[], opts?: { includeToolDefs?: boolean }): string {
  const formatDesc = syntax === 'tool_result'
    ? `<tool_result name="toolName">key=value key2="quoted value"</tool_result>`
    : `<call>toolName key=value key2="quoted value"</call>`;

  const lines: string[] = [
    '# Compact tool calling',
    'You have tools available. Call them using this compact format ONLY:',
    formatDesc,
    '',
    'Rules:',
    '- Simple: text=hello',
    '- Multi-word: message="hello world"',
    '- Numbers: count=42',
    '- Booleans: active=true',
    '',
    '# DO NOT use standard tool_use JSON format — it is NOT available.',
    'Only <call> format is supported.',
    '',
    'Example:',
    '<call>get_weather location=Austin units=imperial</call>',
    '',
  ];

  if (opts?.includeToolDefs) {
    lines.push('Available tools and their parameters:');
    lines.push('');
    for (const p of plans) {
      const fields = p.fields.map(f => {
        const required = f.required ? '(required)' : '(optional)';
        return `    - ${f.name} (${f.type}) ${required}`;
      }).join('\n');
      lines.push(`${p.name}: ${p.description || ''}`);
      if (fields) lines.push(fields);
      lines.push('');
    }
    lines.push('Use <call> format to call any of the above tools.');
  } else {
    lines.push('Available tools:');
    lines.push(...plans.map(p => `- ${p.signature}`));
  }

  return lines.join('\n');
}
