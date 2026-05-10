/**
 * Compact format parser — ported from ai-sdk-wire-middleware.
 *
 * Parses both `<call>name k=v</call>` and `<tool_result name="name">k=v</tool_result>` formats.
 * Same state machine approach. Same wire format (key=value, dot-path nesting, JSON inline arrays).
 */

import type { ToolPlan, ParsedCall } from './types.ts';

// ── Tag constants ────────────────────────────────────────────

export const CALL_OPEN = '<call>';
export const CALL_CLOSE = '</call>';
export const TOOL_RESULT_OPEN_PREFIX = '<tool_result';
export const TOOL_RESULT_CLOSE = '</tool_result>';

// ── Span finding ─────────────────────────────────────────────

/** Find every `<call>…</call>` span in a complete text. */
export function findCallSpans(text: string): Array<{ start: number; end: number; body: string }> {
  const out: Array<{ start: number; end: number; body: string }> = [];
  let i = 0;
  while (true) {
    const open = text.indexOf(CALL_OPEN, i);
    if (open === -1) break;
    const bodyStart = open + CALL_OPEN.length;
    const close = text.indexOf(CALL_CLOSE, bodyStart);
    if (close === -1) break;
    out.push({ start: open, end: close + CALL_CLOSE.length, body: text.slice(bodyStart, close) });
    i = close + CALL_CLOSE.length;
  }
  return out;
}

/** Find every `<tool_result name="…">…</tool_result>` span. */
export function findToolResultSpans(text: string): Array<{ start: number; end: number; toolName: string; body: string }> {
  const out: Array<{ start: number; end: number; toolName: string; body: string }> = [];
  let i = 0;
  while (true) {
    const open = text.indexOf(TOOL_RESULT_OPEN_PREFIX, i);
    if (open === -1) break;
    // Parse name="…" attribute
    const nameMatch = text.slice(open).match(/^<tool_result\s+name="([^"]+)"/);
    if (!nameMatch) { i = open + 1; continue; }
    const toolName = nameMatch[1];
    const bodyStart = open + nameMatch[0].length;
    // Find the > that closes the opening tag
    const tagClose = text.indexOf('>', bodyStart);
    if (tagClose === -1) break;
    const contentStart = tagClose + 1;
    const close = text.indexOf(TOOL_RESULT_CLOSE, contentStart);
    if (close === -1) break;
    out.push({
      start: open,
      end: close + TOOL_RESULT_CLOSE.length,
      toolName,
      body: text.slice(contentStart, close),
    });
    i = close + TOOL_RESULT_CLOSE.length;
  }
  return out;
}

// ── Main parse entry point ───────────────────────────────────

export function parseCompactCalls(text: string, plans: ToolPlan[]): ParsedCall[] {
  const planByName = new Map(plans.map(p => [p.name, p]));
  const calls: ParsedCall[] = [];

  // Try both formats
  for (const span of findCallSpans(text)) {
    const { toolName, argsBody } = splitNameAndBody(span.body);
    const plan = planByName.get(toolName);
    if (!plan) continue; // unknown tool, skip
    const input = encodeArgs(argsBody, plan);
    calls.push({ toolName, input, start: span.start, end: span.end });
  }

  for (const span of findToolResultSpans(text)) {
    const plan = planByName.get(span.toolName);
    if (!plan) continue;
    const input = encodeArgs(span.body, plan);
    calls.push({ toolName: span.toolName, input, start: span.start, end: span.end });
  }

  return calls;
}

// ── Name/body split ──────────────────────────────────────────

export function splitNameAndBody(body: string): { toolName: string; argsBody: string } {
  let i = 0;
  while (i < body.length && /\s/.test(body[i]!)) i++;
  const nameStart = i;
  while (i < body.length && !/\s/.test(body[i]!)) i++;
  const toolName = body.slice(nameStart, i);
  const argsBody = body.slice(i).trim();
  return { toolName, argsBody };
}

// ── Args encoding ───────────────────────────────────────────

export function encodeArgs(argsBody: string, plan: ToolPlan): string {
  if (plan.encoding === 'json') {
    return parseJsonBody(argsBody);
  }
  const flat = parseWireBody(argsBody, plan);
  const hasDotPaths = plan.fields.some(f => f.name.includes('.'));
  if (hasDotPaths) {
    return JSON.stringify(reconstructNested(flat));
  }
  return JSON.stringify(flat);
}

function parseJsonBody(body: string): string {
  if (!body) return '{}';
  const trimmed = body.trim();
  if (!trimmed.startsWith('{')) {
    throw new ToolReduceParseError(
      `Expected a JSON object body for json-encoded tool, got: ${trimmed.slice(0, 60)}`,
    );
  }
  try {
    const parsed = JSON.parse(trimmed);
    return JSON.stringify(parsed);
  } catch (err) {
    throw new ToolReduceParseError(
      `Invalid JSON in tool call body: ${(err as Error).message}`,
    );
  }
}

export function parseWireBody(body: string, plan: ToolPlan): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!body) return out;
  const tokens = tokenizeWire(body);
  for (const tok of tokens) {
    const eq = tok.indexOf('=');
    if (eq === -1) {
      throw new ToolReduceParseError(
        `Expected key=value, got "${tok}" in tool "${plan.name}"`,
        { toolName: plan.name, body },
      );
    }
    const key = tok.slice(0, eq);
    const rawVal = tok.slice(eq + 1);
    const field = plan.fields.find(f => f.name === key);
    out[key] = coerceValue(rawVal, field?.type);
  }
  return out;
}

export function reconstructNested(flat: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(flat)) {
    const parts = key.split('.');
    if (parts.length === 1) {
      out[key] = val;
    } else {
      let current = out;
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i]!;
        if (i === parts.length - 1) {
          current[part] = val;
        } else {
          if (!(part in current) || typeof current[part] !== 'object' || current[part] === null) {
            current[part] = {};
          }
          current = current[part] as Record<string, unknown>;
        }
      }
    }
  }
  return out;
}

export function tokenizeWire(input: string): string[] {
  const out: string[] = [];
  let i = 0;
  let cur = '';
  while (i < input.length) {
    const ch = input[i]!;
    if (/\s/.test(ch)) {
      if (cur.length) { out.push(cur); cur = ''; }
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      cur += ch;
      i++;
      while (i < input.length) {
        const c2 = input[i]!;
        if (c2 === '\\' && i + 1 < input.length) {
          cur += c2 + input[i + 1]!;
          i += 2;
          continue;
        }
        cur += c2;
        i++;
        if (c2 === quote) break;
      }
      continue;
    }
    cur += ch;
    i++;
  }
  if (cur.length) out.push(cur);
  return out;
}

export function coerceValue(raw: string, type: string | undefined): unknown {
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return unquote(raw);
  }
  if (raw.startsWith('[') && raw.endsWith(']')) {
    try { return JSON.parse(raw); } catch { /* fall through */ }
  }
  if (type === 'string') return raw;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null') return null;
  if (type === 'number' || type === 'int') {
    const n = Number(raw);
    if (Number.isFinite(n)) return type === 'int' ? Math.trunc(n) : n;
  } else {
    if (raw.length > 0 && /^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  }
  return raw;
}

function unquote(s: string): string {
  const inner = s.slice(1, -1);
  return inner.replace(/\\(["'\\nrt])/g, (_, c: string) => {
    switch (c) { case 'n': return '\n'; case 'r': return '\r'; case 't': return '\t'; default: return c; }
  });
}

// ── Custom error ─────────────────────────────────────────────

export class ToolReduceParseError extends Error {
  details: { toolName?: string; body?: string };
  constructor(msg: string, details: { toolName?: string; body?: string } = {}) {
    super(msg);
    this.name = 'ToolReduceParseError';
    this.details = details;
  }
}
