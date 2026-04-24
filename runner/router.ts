/**
 * router.ts — Unified LLM router adapter for skill-bench.md
 *
 * Supports:
 *   - OpenAI (gpt-4o, gpt-4-turbo, etc.)
 *   - Anthropic (claude-3-5-sonnet, claude-3-7-sonnet, etc.)
 *   - Gemini (gemini-2.0-flash, gemini-1.5-pro, etc.)
 *   - Mock (deterministic, for CI / offline validation)
 *
 * Usage:
 *   const router = createRouter({ provider: 'openai', model: 'gpt-4o', apiKey: process.env.OPENAI_API_KEY! });
 *   const response = await router.invoke(prompt);
 */

export type Provider = 'openai' | 'anthropic' | 'gemini' | 'mock';

export interface RouterConfig {
  provider: Provider;
  model: string;
  apiKey?: string;
  /** Max tokens to return. Default: 256 */
  maxTokens?: number;
  /** System prompt injected before every bench prompt. */
  systemPrompt?: string;
  /** Request timeout in ms. Default: 30000 */
  timeoutMs?: number;
}

export interface RouterResponse {
  text: string;
  latency_ms: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  model: string;
  provider: Provider;
}

export interface Router {
  invoke(prompt: string): Promise<RouterResponse>;
  config: RouterConfig;
}

const DEFAULT_SYSTEM = `You are a skill routing agent in a benchmark test.
When given a prompt asking you to execute a skill, you MUST return ONLY the token string.
Do not explain. Do not add punctuation. Output only the token.`;

// ---------------------------------------------------------------------------
// OpenAI
// ---------------------------------------------------------------------------
async function invokeOpenAI(prompt: string, config: RouterConfig): Promise<RouterResponse> {
  const t0 = Date.now();
  const body = {
    model: config.model,
    max_tokens: config.maxTokens ?? 256,
    messages: [
      { role: 'system', content: config.systemPrompt ?? DEFAULT_SYSTEM },
      { role: 'user', content: prompt },
    ],
  };

  const res = await fetchWithTimeout(
    'https://api.openai.com/v1/chat/completions',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
    },
    config.timeoutMs ?? 30_000
  );

  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
  const json = await res.json();
  return {
    text: json.choices[0].message.content.trim(),
    latency_ms: Date.now() - t0,
    prompt_tokens: json.usage?.prompt_tokens,
    completion_tokens: json.usage?.completion_tokens,
    model: config.model,
    provider: 'openai',
  };
}

// ---------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------
async function invokeAnthropic(prompt: string, config: RouterConfig): Promise<RouterResponse> {
  const t0 = Date.now();
  const body = {
    model: config.model,
    max_tokens: config.maxTokens ?? 256,
    system: config.systemPrompt ?? DEFAULT_SYSTEM,
    messages: [{ role: 'user', content: prompt }],
  };

  const res = await fetchWithTimeout(
    'https://api.anthropic.com/v1/messages',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': config.apiKey!,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    },
    config.timeoutMs ?? 30_000
  );

  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
  const json = await res.json();
  return {
    text: json.content[0].text.trim(),
    latency_ms: Date.now() - t0,
    prompt_tokens: json.usage?.input_tokens,
    completion_tokens: json.usage?.output_tokens,
    model: config.model,
    provider: 'anthropic',
  };
}

// ---------------------------------------------------------------------------
// Gemini
// ---------------------------------------------------------------------------
async function invokeGemini(prompt: string, config: RouterConfig): Promise<RouterResponse> {
  const t0 = Date.now();
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${config.model}:generateContent?key=${config.apiKey}`;
  const body = {
    system_instruction: { parts: [{ text: config.systemPrompt ?? DEFAULT_SYSTEM }] },
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { maxOutputTokens: config.maxTokens ?? 256 },
  };

  const res = await fetchWithTimeout(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, config.timeoutMs ?? 30_000);

  if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text()}`);
  const json = await res.json();
  return {
    text: json.candidates[0].content.parts[0].text.trim(),
    latency_ms: Date.now() - t0,
    model: config.model,
    provider: 'gemini',
  };
}

// ---------------------------------------------------------------------------
// Mock (deterministic, reads skill token from progressive-manifest or manifest)
// ---------------------------------------------------------------------------
function invokeMock(prompt: string, config: RouterConfig): RouterResponse {
  // Extract token directly from the prompt (format: "...expected token: BENCH-XXX...").
  // Falls back to echo for static routing suite.
  const tokenMatch = prompt.match(/(BENCH-[\w::.]+)/);
  return {
    text: tokenMatch ? tokenMatch[1] : 'BENCH-000::MOCK',
    latency_ms: 5,
    model: 'mock',
    provider: 'mock',
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------
export function createRouter(config: RouterConfig): Router {
  async function invoke(prompt: string): Promise<RouterResponse> {
    switch (config.provider) {
      case 'openai':    return invokeOpenAI(prompt, config);
      case 'anthropic': return invokeAnthropic(prompt, config);
      case 'gemini':    return invokeGemini(prompt, config);
      case 'mock':      return invokeMock(prompt, config);
      default: throw new Error(`Unknown provider: ${(config as RouterConfig).provider}`);
    }
  }
  return { invoke, config };
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------
async function fetchWithTimeout(url: string, options: RequestInit, ms: number): Promise<Response> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}
