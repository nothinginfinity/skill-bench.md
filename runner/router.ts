/**
 * router.ts — Unified LLM router for skill-bench.md
 *
 * Providers: openai | anthropic | gemini | deepseek | groq | cerebras | mock
 *
 * Fix log:
 *   2026-04-24  Fix 2 — 429 retry with exponential backoff (up to 3 retries,
 *               delay * 2^attempt ms between each). Works alongside --delay.
 *   2026-04-24  Fix 3 — DeepSeek reasoning_content fallback (from previous commit,
 *               kept and documented here).
 *   2026-04-24  feat  — Cerebras provider added (OpenAI-compatible endpoint).
 */

export type Provider = 'openai' | 'anthropic' | 'gemini' | 'deepseek' | 'groq' | 'cerebras' | 'mock';

export interface RouterConfig {
  provider: Provider;
  model: string;
  apiKey?: string;
  maxTokens?: number;
  systemPrompt?: string;
  timeoutMs?: number;
  /** ms base delay for 429 retry backoff. Default: uses caller's --delay value or 1000. */
  retryBaseMs?: number;
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

const MAX_RETRIES = 3;

const DEFAULT_SYSTEM =
  `You are a skill routing agent in a benchmark test.\n` +
  `When given a prompt asking you to execute or return a skill token, ` +
  `you MUST return ONLY the token string.\n` +
  `Do not explain. Do not add punctuation. Output only the token.`;

// ---------------------------------------------------------------------------
// Retry wrapper — Fix 2
// ---------------------------------------------------------------------------
async function withRetry<T>(
  fn: () => Promise<T>,
  retryBaseMs: number
): Promise<T> {
  let lastErr: Error = new Error('unknown');
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err as Error;
      const is429 = lastErr.message.includes('429');
      if (!is429 || attempt === MAX_RETRIES) throw lastErr;
      const wait = retryBaseMs * Math.pow(2, attempt);
      console.warn(`  [retry] 429 received, waiting ${wait}ms (attempt ${attempt + 1}/${MAX_RETRIES})...`);
      await sleep(wait);
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// OpenAI-compatible (OpenAI, Groq, DeepSeek, Cerebras)
// ---------------------------------------------------------------------------
async function invokeOpenAICompat(
  baseUrl: string,
  prompt: string,
  config: RouterConfig,
  provider: Provider
): Promise<RouterResponse> {
  const retryBaseMs = config.retryBaseMs ?? 1000;
  return withRetry(async () => {
    const t0  = Date.now();
    const body = {
      model:      config.model,
      max_tokens: config.maxTokens ?? 256,
      messages: [
        { role: 'system', content: config.systemPrompt ?? DEFAULT_SYSTEM },
        { role: 'user',   content: prompt },
      ],
    };
    const res = await fetchWithTimeout(
      `${baseUrl}/chat/completions`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify(body),
      },
      config.timeoutMs ?? 30_000
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    const json = await res.json();
    const msg  = json.choices[0].message;
    // Fix 3: DeepSeek-Reasoner reasoning_content fallback
    const text: string =
      (msg.content && msg.content.trim().length > 0)
        ? msg.content.trim()
        : (msg.reasoning_content ?? '').trim();
    return {
      text,
      latency_ms:        Date.now() - t0,
      prompt_tokens:     json.usage?.prompt_tokens,
      completion_tokens: json.usage?.completion_tokens,
      model:    config.model,
      provider,
    };
  }, retryBaseMs);
}

function invokeOpenAI(prompt: string, config: RouterConfig)   { return invokeOpenAICompat('https://api.openai.com/v1', prompt, config, 'openai'); }
function invokeGroq(prompt: string, config: RouterConfig)     { return invokeOpenAICompat('https://api.groq.com/openai/v1', prompt, config, 'groq'); }
function invokeDeepSeek(prompt: string, config: RouterConfig) { return invokeOpenAICompat('https://api.deepseek.com/v1', prompt, config, 'deepseek'); }
function invokeCerebras(prompt: string, config: RouterConfig) { return invokeOpenAICompat('https://api.cerebras.ai/v1', prompt, config, 'cerebras'); }

// ---------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------
async function invokeAnthropic(prompt: string, config: RouterConfig): Promise<RouterResponse> {
  const retryBaseMs = config.retryBaseMs ?? 1000;
  return withRetry(async () => {
    const t0  = Date.now();
    const res = await fetchWithTimeout(
      'https://api.anthropic.com/v1/messages',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': config.apiKey!,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model:      config.model,
          max_tokens: config.maxTokens ?? 256,
          system:     config.systemPrompt ?? DEFAULT_SYSTEM,
          messages:   [{ role: 'user', content: prompt }],
        }),
      },
      config.timeoutMs ?? 30_000
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    const json = await res.json();
    return {
      text:              json.content[0].text.trim(),
      latency_ms:        Date.now() - t0,
      prompt_tokens:     json.usage?.input_tokens,
      completion_tokens: json.usage?.output_tokens,
      model:    config.model,
      provider: 'anthropic',
    };
  }, retryBaseMs);
}

// ---------------------------------------------------------------------------
// Gemini
// ---------------------------------------------------------------------------
async function invokeGemini(prompt: string, config: RouterConfig): Promise<RouterResponse> {
  const retryBaseMs = config.retryBaseMs ?? 1000;
  return withRetry(async () => {
    const t0  = Date.now();
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${config.model}:generateContent?key=${config.apiKey}`;
    const res = await fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: config.systemPrompt ?? DEFAULT_SYSTEM }] },
          contents:           [{ parts: [{ text: prompt }] }],
          generationConfig:   { maxOutputTokens: config.maxTokens ?? 256 },
        }),
      },
      config.timeoutMs ?? 30_000
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    const json = await res.json();
    return {
      text:      json.candidates[0].content.parts[0].text.trim(),
      latency_ms: Date.now() - t0,
      model:    config.model,
      provider: 'gemini',
    };
  }, retryBaseMs);
}

// ---------------------------------------------------------------------------
// Mock — deterministic, for CI / offline
// ---------------------------------------------------------------------------
function invokeMock(prompt: string, config: RouterConfig): RouterResponse {
  const tokenMatch = prompt.match(/(BENCH-[\w:.]+)/);
  return {
    text:      tokenMatch ? tokenMatch[1] : 'BENCH-000::MOCK',
    latency_ms: 5,
    model:    'mock',
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
      case 'deepseek':  return invokeDeepSeek(prompt, config);
      case 'groq':      return invokeGroq(prompt, config);
      case 'cerebras':  return invokeCerebras(prompt, config);
      case 'mock':      return invokeMock(prompt, config);
      default: throw new Error(`Unknown provider: ${(config as RouterConfig).provider}`);
    }
  }
  return { invoke, config };
}

// ---------------------------------------------------------------------------
// Utilities
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

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
