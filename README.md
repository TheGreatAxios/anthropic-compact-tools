# anthropic-compact-tools

Compact-syntax tool calling for the Anthropic TypeScript SDK.  
Replaces verbose `tool_use` JSON blocks with a compact `<call>name k=v</call>` or `<tool_result name="name">k=v</tool_result>` wire format.

The goal: reduce output tokens by reducing the structural overhead the model generates on every tool call. Results vary by model, task complexity, and conversation length. Run the benchmark on your workload to measure the effect.

```ts
import { CompactAnthropic } from 'anthropic-compact-tools';
const client = new CompactAnthropic({ apiKey: 'sk-...' });

const response = await client.messages.create({
  model: 'claude-sonnet-4-5',
  max_tokens: 1024,
  tools: [{ name: 'get_weather', description: '...', input_schema: { ... } }],
  messages: [{ role: 'user', content: 'What is the weather in Austin?' }],
});
// response.content has standard tool_use blocks — works as expected
```

## Install

```sh
npm install anthropic-compact-tools
# or
bun add anthropic-compact-tools
```

## Usage

### Basic

```ts
import { CompactAnthropic } from 'anthropic-compact-tools';

const client = new CompactAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const response = await client.messages.create({
  model: 'claude-sonnet-4-5',
  max_tokens: 1024,
  tools: [{ name: 'get_weather', description: '...', input_schema: {...} }],
  messages: [{ role: 'user', content: 'Weather in Austin?' }],
});
```

### Wrap an existing client

```ts
import Anthropic from '@anthropic-ai/sdk';
import { CompactAnthropic } from 'anthropic-compact-tools';

const raw = new Anthropic({ apiKey: 'sk-...' });
const client = new CompactAnthropic(raw, { syntax: 'tool_result' });
```

### Options

```ts
const client = new CompactAnthropic({ apiKey: 'sk-...' }, {
  syntax: 'tool_result',       // 'wire' | 'tool_result' (default 'wire')
  placement: 'first_user',     // 'first_user' | 'system' (default 'first_user')
  rewriteHistory: true,        // rewrite prior tool_use blocks to compact (default true)
  minifyToolDefinitions: false, // OPT-IN: strip descriptions from tool schemas
});
```

## How it works

```
Before API call:
  tools[]         → UNCHANGED (prompt cache preserved)
  system          → UNCHANGED
  first message   → format instruction prepended (safe for all cache breakpoints)
  history         → prior tool_use blocks rewritten to compact text

After API call:
  response text scanned for compact spans
  key=value args parsed back to structured JSON
  synthetic tool_use content blocks emitted
  dual-format: native tool_use + compact both handled
```

## Prompt caching

The `tools` array is never modified. The format instruction goes in the first user message, which is after every possible cache breakpoint (tools, system, messages). Zero cache invalidation.

## Syntax

### `wire` (default)

```
<call>getWeather location=Austin units=metric</call>
```

### `tool_result`

```
<tool_result name="getWeather">location=Austin units=metric</tool_result>
```

### Wire format rules

```
key=value              → bare values
key="quoted value"     → values with spaces
key=["a","b"]          → arrays (JSON inline)
profile.name=Alice     → nested objects (dot-path flattening)
```

## Benchmark

```sh
bun run bench               # Offline token comparison (no API key)
ANTHROPIC_API_KEY=sk-... bun run bench:live              # Real API benchmark
bun run bench:live --compare --save   # Compare saved runs, export markdown
```

## Tests

```sh
bun test          # 50 tests, no API key needed
```

## License

MIT — see [LICENSE](LICENSE).

Copyright (c) 2026 Sawyer Cutler
