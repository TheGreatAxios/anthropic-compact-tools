/**
 * anthropic-compact-tools — compact wire format for Anthropic SDK tool calling.
 *
 * Primary API: CompactAnthropic class — drop-in replacement for the Anthropic client
 * that automatically uses compact tool calling. Replaces verbose tool_use JSON with
 * a compact wire format to reduce output tokens.
 *
 * ```ts
 * import { CompactAnthropic } from 'anthropic-compact-tools';
 *
 * const client = new CompactAnthropic({ apiKey: 'sk-...' });
 * const response = await client.messages.create({
 *   model: 'claude-sonnet-4-5',
 *   max_tokens: 1024,
 *   tools: [...],
 *   messages: [{ role: 'user', content: 'Weather?' }],
 * });
 * ```
 */

import Anthropic from '@anthropic-ai/sdk';
import type {
  CompactToolsOptions,
  MessagesCreateParams,
  MessageResponse,
} from './types.ts';
import { transformRequest, transformResponse } from './transform.ts';

// ── Re-exports ────────────────────────────────────────────────

export type { CompactToolsOptions, CompactSyntax } from './types.ts';
export { ToolReduceParseError } from './parser.ts';
export { planTools, generateFormatInstruction, renderSignature } from './signature.ts';
export { parseCompactCalls, findCallSpans, findToolResultSpans } from './parser.ts';
export { serializeCall, serializeToolResultCall, serializeToolCall } from './serialize.ts';

// ── Options resolution ───────────────────────────────────────

interface ResolvedOptions {
  syntax: 'wire' | 'tool_result';
  placement: 'system' | 'first_user';
  rewriteHistory: boolean;
  minifyToolDefinitions: boolean;
}

function resolveOptions(options: CompactToolsOptions): ResolvedOptions {
  return {
    syntax: options.syntax ?? 'wire',
    placement: options.placement ?? 'first_user',
    rewriteHistory: options.rewriteHistory ?? true,
    minifyToolDefinitions: options.minifyToolDefinitions ?? false,
  };
}

// ── CompactAnthropic class ────────────────────────────────────

type ClientOptions = ConstructorParameters<typeof Anthropic>[0];

/**
 * CompactAnthropic — a drop-in replacement for the Anthropic client
 * that automatically uses compact tool calling on all messages.create() calls.
 *
 * Accepts the same constructor params as Anthropic, or an existing instance:
 *
 * ```ts
 * const client = new CompactAnthropic({ apiKey: 'sk-...' });
 * const client = new CompactAnthropic(new Anthropic({ apiKey: '...' }), { syntax: 'tool_result' });
 * ```
 */
export class CompactAnthropic {
  /** The underlying Anthropic client — access for advanced use */
  public readonly client: Anthropic;

  private options: ResolvedOptions;
  private _messages: Anthropic['messages'] | null = null;

  constructor(clientOrOptions?: Anthropic | ClientOptions, options: CompactToolsOptions = {}) {
    this.client = clientOrOptions instanceof Anthropic
      ? clientOrOptions
      : new Anthropic(clientOrOptions ?? {});
    this.options = resolveOptions(options);
  }

  /** Messages API — create() automatically uses compact tool calling */
  get messages(): Anthropic['messages'] {
    if (!this._messages) {
      const self = this;
      const originalCreate = this.client.messages.create.bind(this.client);
      this._messages = new Proxy(this.client.messages, {
        get(target, prop, receiver) {
          if (prop === 'create') {
            return async (params: MessagesCreateParams): Promise<MessageResponse> => {
              const { params: transformed, plans } = transformRequest(params as any, self.options);
              const response = await originalCreate(transformed as any);
              return transformResponse(response as any, plans);
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      });
    }
    return this._messages;
  }

  /** Beta API — passes through to underlying client unchanged */
  get beta(): Anthropic['beta'] {
    return this.client.beta;
  }
}
