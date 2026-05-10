/**
 * Stream interceptor for compact format.
 *
 * Intercepts raw SSE events from Anthropic's async iterable API.
 * Scans text deltas for compact format spans (<call> or <tool_result>),
 * splits text content blocks around them, emits synthetic tool_use events.
 *
 * O(n) per delta: only scans new content since last check point.
 * Dual-format: native tool_use passes through; compact spans in text get converted.
 */

import type { ToolPlan, SSEEvent } from './types.ts';
import { findCallSpans, findToolResultSpans, encodeArgs, splitNameAndBody } from './parser.ts';

let _idCounter = 0;
function genId(): string {
  return `tu_${Date.now().toString(36)}_${(_idCounter++).toString(36)}`;
}

/** Track a text block being accumulated */
interface TextBlockState {
  buffer: string;
  /** Byte position up to which we've already scanned for calls (O(n) optimization) */
  scannedUpTo: number;
}

/**
 * Transform an SSE event stream.
 *
 * Strategy:
 * 1. Track text content blocks, accumulate text deltas.
 * 2. On each delta, scan only the NEW content for complete compact calls.
 * 3. When a complete call is found, emit synthetic tool_use events with new indices.
 * 4. Native tool_use blocks pass through unchanged.
 */
export async function* transformStream(
  stream: AsyncIterable<SSEEvent>,
  plans: ToolPlan[],
): AsyncIterable<SSEEvent> {
  if (plans.length === 0) {
    yield* stream;
    return;
  }

  const planByName = new Map(plans.map(p => [p.name, p]));
  const textBlocks = new Map<number, TextBlockState>();
  let nextIndex = 0;
  let emittedAnyCall = false;

  for await (const event of stream) {
    switch (event.type) {

      case 'message_start':
        nextIndex = 0;
        emittedAnyCall = false;
        yield event;
        break;

      case 'content_block_start': {
        nextIndex = Math.max(nextIndex, event.index + 1);
        if (event.content_block.type === 'text') {
          textBlocks.set(event.index, { buffer: (event.content_block as any).text ?? '', scannedUpTo: 0 });
        }
        yield event;
        break;
      }

      case 'content_block_delta': {
        const delta = event.delta;
        if (delta.type !== 'text_delta') { yield event; break; }

        const block = textBlocks.get(event.index);
        if (!block) { yield event; break; }

        const newText = (delta as any).text;
        block.buffer += newText;

        // Only scan the new portion for complete calls (O(n) per delta, not O(n²))
        const calls = findCompactCalls(block.buffer, block.scannedUpTo, planByName);
        if (calls.length === 0) {
          // No complete calls yet — emit the delta as-is
          block.scannedUpTo = block.buffer.length;
          yield event;
          break;
        }

        // Found complete calls. Process each one.
        // Emit leading text (before first call) as a corrected delta
        const firstCall = calls[0]!;
        const leadingText = block.buffer.slice(0, firstCall.start);
        if (leadingText.length > 0) {
          yield { type: 'content_block_delta', index: event.index, delta: { type: 'text_delta', text: leadingText } };
        }

        // Emit synthetic tool_use events for each call
        for (const call of calls) {
          const toolIdx = nextIndex++;
          yield { type: 'content_block_start', index: toolIdx, content_block: { type: 'tool_use', id: genId(), name: call.toolName, input: JSON.parse(call.input) } };
          yield { type: 'content_block_delta', index: toolIdx, delta: { type: 'input_json_delta', partial_json: call.input } };
          yield { type: 'content_block_stop', index: toolIdx };
          emittedAnyCall = true;
        }

        // Remaining text goes back in the buffer
        const lastCallEnd = calls[calls.length - 1]!.end;
        const remainingText = block.buffer.slice(lastCallEnd);
        block.buffer = remainingText;
        block.scannedUpTo = 0; // reset — remaining text needs fresh scan

        // Emit remaining text as delta if non-empty
        if (remainingText.length > 0) {
          yield { type: 'content_block_delta', index: event.index, delta: { type: 'text_delta', text: remainingText } };
        }
        break;
      }

      case 'content_block_stop': {
        const block = textBlocks.get(event.index);
        if (block) {
          // Process any calls the buffer still has (e.g., if call completed exactly at block stop)
          const calls = findCompactCalls(block.buffer, 0, planByName);
          for (const call of calls) {
            const toolIdx = nextIndex++;
            yield { type: 'content_block_start', index: toolIdx, content_block: { type: 'tool_use', id: genId(), name: call.toolName, input: JSON.parse(call.input) } };
            yield { type: 'content_block_delta', index: toolIdx, delta: { type: 'input_json_delta', partial_json: call.input } };
            yield { type: 'content_block_stop', index: toolIdx };
            emittedAnyCall = true;
          }
          textBlocks.delete(event.index);
        }
        yield event;
        break;
      }

      case 'message_delta': {
        if (emittedAnyCall) {
          yield { type: 'message_delta', delta: { ...event.delta, stop_reason: 'tool_use' }, usage: event.usage };
          emittedAnyCall = false;
        } else {
          yield event;
        }
        break;
      }

      default:
        yield event;
    }
  }
}

/**
 * Find complete compact calls in text, starting from `fromPos`.
 * Only returns calls that are fully contained in text (open + close tags both found).
 * O(n) on the new portion of text — only scans from the last known position.
 */
function findCompactCalls(
  text: string,
  fromPos: number,
  planByName: Map<string, ToolPlan>,
): Array<{ toolName: string; input: string; start: number; end: number }> {
  const calls: Array<{ toolName: string; input: string; start: number; end: number }> = [];
  const searchRegion = text.slice(fromPos);

  for (const span of findCallSpans(searchRegion)) {
    const adjStart = fromPos + span.start;
    const adjEnd = fromPos + span.end;
    const { toolName, argsBody } = splitNameAndBody(span.body);
    const plan = planByName.get(toolName);
    if (!plan) continue;
    try {
      const input = encodeArgs(argsBody, plan);
      calls.push({ toolName, input, start: adjStart, end: adjEnd });
    } catch { /* skip malformed */ }
  }

  for (const span of findToolResultSpans(searchRegion)) {
    const adjStart = fromPos + span.start;
    const adjEnd = fromPos + span.end;
    const plan = planByName.get(span.toolName);
    if (!plan) continue;
    try {
      const input = encodeArgs(span.body, plan);
      calls.push({ toolName: span.toolName, input, start: adjStart, end: adjEnd });
    } catch { /* skip */ }
  }

  calls.sort((a, b) => a.start - b.start);

  // De-dup overlapping calls (prefer the first one)
  const deduped: typeof calls = [];
  for (const call of calls) {
    if (deduped.length === 0 || call.start >= deduped[deduped.length - 1]!.end) {
      deduped.push(call);
    }
  }

  return deduped;
}
