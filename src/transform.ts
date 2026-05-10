/**
 * Request/response transform logic.
 *
 * Before the API call:
 *   1. Minify tool definitions (strip verbose descriptions from JSON Schema)
 *   2. Plan tools (for history rewriting and response parsing)
 *   3. Rewrite conversation history (tool_use → compact)
 *
 * After the API call (non-streaming):
 *   1. Scan text content blocks for compact format
 *   2. Convert to synthetic tool_use blocks
 *
 * No format instruction is injected — the model uses native JSON output.
 * Compact format is only used for history compression and as an optional
 * output format the model may adopt naturally from seeing it in context.
 *
 * For streaming, see stream.ts.
 */

import type { ToolPlan, CompactToolsOptions, AnthropicTool, MessagesCreateParams, MessageResponse, ContentBlock } from './types.ts';
import { planTools } from './signature.ts';
import { rewriteHistory } from './serialize.ts';
import { parseCompactCalls } from './parser.ts';

let _idCounter = 0;
function genId(): string {
  return `tu_${Date.now().toString(36)}_${(_idCounter++).toString(36)}`;
}

/**
 * Strip verbose descriptions from tool definition schemas to reduce input tokens.
 * Keeps the schema valid (types, enums, items, required) but strips description
 * text that bloats the cached prefix.
 *
 * The model still sees full descriptions via the Anthropic tool definition system
 * (the `description` field on the tool itself is preserved). Only per-property
 * descriptions in input_schema are stripped.
 */
export function minifyToolDefs(tools: AnthropicTool[]): AnthropicTool[] {
  return tools.map(tool => {
    const schema = tool.input_schema as Record<string, unknown>;
    if (!schema || typeof schema !== 'object') return tool;

    const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
    if (!properties) return tool;

    const minifiedProps: Record<string, Record<string, unknown>> = {};
    for (const [key, prop] of Object.entries(properties)) {
      const minified: Record<string, unknown> = {};
      if (prop.type) minified.type = prop.type;
      if (prop.enum) minified.enum = prop.enum;
      if (prop.items) minified.items = prop.items;
      // Strip: description, examples, title, format, default, etc.
      minifiedProps[key] = minified;
    }

    return {
      ...tool,
      input_schema: {
        type: schema.type ?? 'object',
        properties: minifiedProps,
        ...(schema.required ? { required: schema.required } : {}),
      },
    };
  });
}

/**
 * Transform request parameters before sending to the Anthropic API.
 *
 * Two optimizations (both input-side only):
 *  1. Minify tool definitions — strip verbose descriptions from JSON Schema
 *  2. Rewrite conversation history — prior tool_use → compact text
 *
 * No format instruction is injected into the prompt. The model uses native
 * JSON tool_use blocks for its own output. Compact format is only used for
 * history compression (smaller multi-turn context).
 *
 * On the output side, transformResponse() transparently accepts both native
 * JSON tool_use blocks and compact <call> format if the model picks it up
 * from history.
 *
 * Preserves prompt caching: minified tools array stays intact.
 */
export function transformRequest(
  params: MessagesCreateParams,
  options: Required<Pick<CompactToolsOptions, 'syntax' | 'placement' | 'rewriteHistory'>> & Pick<CompactToolsOptions, 'minifyToolDefinitions'>,
): {
  params: MessagesCreateParams;
  plans: ToolPlan[];
} {
  const tools = params.tools as AnthropicTool[] | undefined;

  // No tools — nothing to do
  if (!tools || tools.length === 0) {
    return { params, plans: [] };
  }

  // Plan tools (needed for history rewriting and response parsing)
  const plans = planTools(tools);

  // Minify tool definitions to reduce cached input tokens
  const finalTools = options.minifyToolDefinitions ? minifyToolDefs(tools) : tools;

  // Clone params to avoid mutating the caller's object
  const out: MessagesCreateParams = { ...params, tools: finalTools as typeof params.tools };

  // Rewrite history if enabled — convert past tool_use blocks to compact format
  if (options.rewriteHistory) {
    out.messages = rewriteHistory(out.messages ?? [], plans, options.syntax);
  }

  return { params: out, plans };
}

/**
 * Transform response after receiving from the Anthropic API (non-streaming).
 * Scans text content blocks for compact format, converts to tool_use blocks.
 */
export function transformResponse(
  response: MessageResponse,
  plans: ToolPlan[],
): MessageResponse {
  if (plans.length === 0) return response;

  const newContent: ContentBlock[] = [];
  let hasCompactCalls = false;

  for (const block of response.content) {
    if (block.type !== 'text') {
      newContent.push(block);
      continue;
    }

    const text = block.text;
    const calls = parseCompactCalls(text, plans);

    if (calls.length === 0) {
      newContent.push(block);
      continue;
    }

    // Split text around the compact calls
    let cursor = 0;
    for (const call of calls) {
      // Emit leading text
      if (call.start > cursor) {
        const leading = text.slice(cursor, call.start);
        if (leading.trim()) {
          newContent.push({ type: 'text', text: leading });
        }
      }
      // Emit synthetic tool_use block
      newContent.push({
        type: 'tool_use',
        id: genId(),
        name: call.toolName,
        input: JSON.parse(call.input),
      });
      hasCompactCalls = true;
      cursor = call.end;
    }
    // Trailing text
    if (cursor < text.length) {
      const trailing = text.slice(cursor);
      if (trailing.trim()) {
        newContent.push({ type: 'text', text: trailing });
      }
    }
  }

  return {
    ...response,
    content: newContent,
    stop_reason: hasCompactCalls ? 'tool_use' : response.stop_reason,
  };
}
