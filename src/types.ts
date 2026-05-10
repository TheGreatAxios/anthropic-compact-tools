/**
 * Types for anthropic-compact-tools
 */

/** Supported compact output syntaxes */
export type CompactSyntax = 'wire' | 'tool_result';

/** Options for compact tool calling */
export interface CompactToolsOptions {
  syntax?: CompactSyntax;
  placement?: 'system' | 'first_user';
  formatInstruction?: string;
  rewriteHistory?: boolean;
  /** Strip verbose descriptions from tool JSON Schema to reduce input tokens. */
  minifyToolDefinitions?: boolean;
  /** 
   * Strip `tools` from the API call and inject tool definitions into the 
   * system message instead. This FORCES the model to use compact text format 
   * since native tool_use blocks are not available. Defaults to `true`.
   */
  stripTools?: boolean;
  debug?: boolean;
}

/** Resolved per-tool plan */
export interface ToolPlan {
  name: string;
  description?: string;
  signature: string;
  encoding: 'wire' | 'json';
  fields: Array<{ name: string; required: boolean; type: string }>;
  inputSchema: unknown;
}

/** A single parsed compact call */
export interface ParsedCall {
  toolName: string;
  input: string; // JSON-stringified args
  start: number;
  end: number;
}

/** Anthropic SDK tool shape */
export interface AnthropicTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/** Content block types — extended to match SDK */
export interface ToolUseBlock { type: 'tool_use'; id: string; name: string; input: unknown }
export interface TextBlock { type: 'text'; text: string }
export interface ThinkingBlock { type: 'thinking'; thinking: string; signature?: string }
export type ContentBlock = TextBlock | ToolUseBlock | ThinkingBlock;

/** Message in the messages array */
export interface MessageParam {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
}

/** Messages.create() params — subset of what the SDK accepts */
export interface MessagesCreateParams {
  model: string;
  max_tokens: number;
  system?: string | Array<{ type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }>;
  messages: MessageParam[];
  tools?: AnthropicTool[];
  tool_choice?: { type: 'auto' | 'any' | 'none' | 'tool'; name?: string };
  [key: string]: unknown;
}

/** Non-streaming response */
export interface MessageResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  content: ContentBlock[];
  stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | null;
  stop_sequence: string | null;
  usage: { input_tokens: number; output_tokens: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number };
  [key: string]: unknown;
}

/** SSE event from the Anthropic stream API */
export interface SSEContentBlockStart {
  type: 'content_block_start';
  index: number;
  content_block: { type: string; [k: string]: unknown };
}
export interface SSEContentBlockDelta {
  type: 'content_block_delta';
  index: number;
  delta: { type: string; [k: string]: unknown };
}
export interface SSEContentBlockStop { type: 'content_block_stop'; index: number }
export interface SSEMessageDelta {
  type: 'message_delta';
  delta: Record<string, unknown>;
  usage: { output_tokens: number; [k: string]: unknown };
}

export type SSEEvent =
  | { type: 'message_start'; message: Record<string, unknown> }
  | SSEContentBlockStart
  | SSEContentBlockDelta
  | SSEContentBlockStop
  | SSEMessageDelta
  | { type: 'message_stop' }
  | { type: 'ping' }
  | { type: 'error'; error: { type: string; message: string } };
