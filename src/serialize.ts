/**
 * Compact format serializer — converts tool calls to compact wire format.
 * Used for history rewriting so the model sees self-consistent compact text.
 */

import type { ToolPlan, ContentBlock, MessageParam } from './types.ts';

/** Flatten nested values from an object into dot-path keys. O(n) on depth. */
function flattenNested(obj: Record<string, unknown>, prefix = ''): Array<[string, unknown]> {
  const out: Array<[string, unknown]> = [];
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
      out.push(...flattenNested(v as Record<string, unknown>, key));
    } else {
      out.push([key, v]);
    }
  }
  return out;
}

/**
 * Serialize a tool call into compact format.
 * @param syntax 'wire' → `<call>name k=v</call>`, 'tool_result' → `<tool_result name="name">k=v</tool_result>`
 */
export function serializeToolCall(
  toolName: string,
  input: Record<string, unknown>,
  syntax: 'wire' | 'tool_result',
  plan?: ToolPlan,
): string {
  const openTag = syntax === 'tool_result'
    ? `<tool_result name="${toolName}">`
    : `<call>${toolName}`;
  const closeTag = syntax === 'tool_result' ? '</tool_result>' : '</call>';

  // JSON encoding or no plan: fall back to JSON body
  if (!plan || plan.encoding === 'json') {
    return `${openTag}${JSON.stringify(input)}${closeTag}`;
  }

  // Wire encoding: flatten nested, format as key=value
  const entries = flattenNested(input);
  if (entries.length === 0) {
    return `${openTag}${closeTag}`;
  }

  const parts = entries.map(([k, v]) => {
    const fieldType = plan.fields.find(f => f.name === k)?.type;
    return `${k}=${formatValue(v, fieldType)}`;
  });

  const separator = syntax === 'tool_result' ? '' : ' ';
  return `${openTag}${separator}${parts.join(' ')}${closeTag}`;
}

function formatValue(v: unknown, type?: string): string {
  if (v == null) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') {
    if (needsQuoting(v) || type === undefined) return quoteString(v);
    return v;
  }
  if (Array.isArray(v)) return JSON.stringify(v);
  return JSON.stringify(v);
}

function quoteString(s: string): string {
  if (!needsQuoting(s) && !looksLikeKeyword(s) && !looksLikeNumber(s)) return s;
  if (s.includes('"') && !s.includes("'")) return `'${s}'`;
  return JSON.stringify(s);
}

function needsQuoting(s: string): boolean { return s.length === 0 || /[\s"'=<>]/.test(s); }
function looksLikeKeyword(s: string): boolean { return s === 'true' || s === 'false' || s === 'null'; }
function looksLikeNumber(s: string): boolean { return /^-?\d+(\.\d+)?$/.test(s); }

// Convenience wrappers
export const serializeCall = (n: string, i: Record<string, unknown>, p?: ToolPlan) => serializeToolCall(n, i, 'wire', p);
export const serializeToolResultCall = (n: string, i: Record<string, unknown>, p?: ToolPlan) => serializeToolCall(n, i, 'tool_result', p);

/**
 * Rewrite conversation history: convert tool_use blocks in assistant messages
 * to compact text, so the model sees a self-consistent compact transcript.
 */
export function rewriteHistory(
  messages: MessageParam[],
  plans: ToolPlan[],
  syntax: 'wire' | 'tool_result',
): MessageParam[] {
  const planByName = new Map(plans.map(p => [p.name, p]));
  const out: MessageParam[] = [];

  for (const msg of messages) {
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      out.push({ role: 'assistant', content: serializeAssistantContent(msg.content, planByName, syntax) });
    } else if (msg.role === 'user' && Array.isArray(msg.content)) {
      const hasToolResults = msg.content.some(p => (p as any).type === 'tool_result');
      if (hasToolResults) {
        const texts = msg.content
          .filter(p => (p as any).type === 'text')
          .map(p => (p as any).text);
        out.push({ role: 'user', content: texts.join('\n').trim() || ' ' });
      } else {
        out.push(msg);
      }
    } else {
      out.push(msg);
    }
  }

  return mergeConsecutiveUsers(out);
}

function serializeAssistantContent(
  content: ContentBlock[],
  planByName: Map<string, ToolPlan>,
  syntax: 'wire' | 'tool_result',
): string {
  const buf: string[] = [];
  for (const part of content) {
    if (part.type === 'text') {
      buf.push(part.text);
    } else if (part.type === 'tool_use') {
      const plan = planByName.get(part.name);
      const input = typeof part.input === 'object' && part.input !== null
        ? part.input as Record<string, unknown>
        : {};
      buf.push(serializeToolCall(part.name, input, syntax, plan));
    }
  }
  return buf.join('\n').trim() || ' ';
}

function mergeConsecutiveUsers(messages: MessageParam[]): MessageParam[] {
  const out: MessageParam[] = [];
  for (const msg of messages) {
    const last = out[out.length - 1];
    if (last && last.role === 'user' && msg.role === 'user') {
      const lastText = typeof last.content === 'string' ? last.content : last.content.map(p => (p as any).text || '').join('\n');
      const newText = typeof msg.content === 'string' ? msg.content : msg.content.map(p => (p as any).text || '').join('\n');
      out[out.length - 1] = { role: 'user', content: [lastText, newText].join('\n') };
      continue;
    }
    out.push(msg);
  }
  return out;
}
