/**
 * Claude client (§B1/B2/B7).
 *
 * Raw fetch rather than the SDK — one less dependency in the build worker, and
 * the only thing we need is forced tool-calling.
 *
 * The critical technique: `tool_choice: {type:'tool', name}` makes the model
 * physically unable to reply with prose. It must emit a schema-shaped object,
 * which removes the entire class of "the LLM returned markdown around my JSON"
 * failures. Validation still runs afterwards — see §B3.
 */

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';

export const MODELS = {
  classify: process.env.MODEL_CLASSIFY || 'claude-haiku-4-5-20251001',
  config: process.env.MODEL_CONFIG || 'claude-sonnet-5',
};

export function hasApiKey() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

export class ClaudeError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = 'ClaudeError';
    this.status = status;
    this.body = body;
  }
}

/**
 * Call Claude and return the forced tool's input object.
 * Retries transient failures (429 / 5xx / network) with exponential backoff.
 */
export async function callTool({
  model,
  system,
  messages,
  tool,
  maxTokens = 4096,
  temperature = 1,
  retries = 3,
  timeoutMs = 60_000,
}) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new ClaudeError('ANTHROPIC_API_KEY is not set');

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    const started = Date.now();
    try {
      const res = await fetch(API_URL, {
        method: 'POST',
        signal: ac.signal,
        headers: {
          'content-type': 'application/json',
          'x-api-key': key,
          'anthropic-version': API_VERSION,
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          temperature,
          system,
          messages,
          tools: [tool],
          tool_choice: { type: 'tool', name: tool.name },
        }),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        const retryable = res.status === 429 || res.status >= 500;
        if (retryable && attempt < retries) {
          await sleep(600 * 2 ** attempt);
          continue;
        }
        throw new ClaudeError(`Claude API ${res.status}`, { status: res.status, body: body.slice(0, 600) });
      }

      const json = await res.json();
      const block = (json.content || []).find((c) => c.type === 'tool_use' && c.name === tool.name);
      if (!block) {
        throw new ClaudeError(`model did not call ${tool.name}`, { body: JSON.stringify(json).slice(0, 600) });
      }

      return {
        input: block.input,
        usage: {
          model,
          inputTokens: json.usage?.input_tokens ?? 0,
          outputTokens: json.usage?.output_tokens ?? 0,
          latencyMs: Date.now() - started,
        },
      };
    } catch (err) {
      lastErr = err;
      const transient = err.name === 'AbortError' || err.name === 'TypeError';
      if (transient && attempt < retries) {
        await sleep(600 * 2 ** attempt);
        continue;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr ?? new ClaudeError('exhausted retries');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Rough USD cost, used to populate the `generations` audit table (§B8).
 * Update when pricing changes — treat as indicative, not billing-grade.
 */
const PRICING_PER_MTOK = {
  'claude-haiku-4-5-20251001': { in: 1.0, out: 5.0 },
  'claude-sonnet-5': { in: 3.0, out: 15.0 },
  'claude-opus-5': { in: 15.0, out: 75.0 },
};

export function estimateCostUsd(usage) {
  const p = PRICING_PER_MTOK[usage.model];
  if (!p) return null;
  return Math.round(((usage.inputTokens / 1e6) * p.in + (usage.outputTokens / 1e6) * p.out) * 1e6) / 1e6;
}
