/**
 * concurrency.ts — Semaphore for limiting parallel in-flight LLM requests
 *
 * Why this exists:
 *   Concurrent requests without a semaphore cause two distinct failure modes
 *   observed in skill-bench runs 7-9:
 *
 *   1. Groq free tier (llama-3.1-8b): 167/200 requests returned HTTP 429.
 *      Concurrent fire bypassed --delay entirely, exhausting ~30 RPM in seconds.
 *
 *   2. OpenAI gpt-4o: Zero rate-limit errors, but 190-194/200 responses
 *      returned the bench-001 ghost token. Avg latency spiked from 192ms to
 *      774-922ms, indicating the model queued concurrent context and anchored
 *      on the first token it processed for all subsequent responses.
 *
 * Solution: a simple promise-based semaphore. Max N requests in flight at once.
 * --delay still applies between completions within each semaphore slot.
 *
 * Safe defaults by provider (baked into package.json scripts):
 *   Groq / Cerebras free tier  — concurrency 1, delay 2000ms
 *   OpenAI / Anthropic / Gemini — concurrency 5, delay 0ms
 *   DeepSeek                    — concurrency 3, delay 0ms
 */

export class Semaphore {
  private queue: Array<() => void> = [];
  private active = 0;

  constructor(private readonly limit: number) {}

  async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active++;
      return;
    }
    return new Promise<void>(resolve => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    this.active--;
    const next = this.queue.shift();
    if (next) {
      this.active++;
      next();
    }
  }

  /** Run fn with semaphore acquisition + auto-release */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  get activeCount()  { return this.active; }
  get pendingCount() { return this.queue.length; }
}

/**
 * Run an array of tasks with bounded concurrency.
 * Results are returned in the same order as tasks (Promise.allSettled semantics).
 *
 * @param tasks    Array of async functions to execute
 * @param limit    Max concurrent executions
 * @param delayMs  ms to wait after each task completes before releasing the slot
 */
export async function runWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  limit: number,
  delayMs = 0
): Promise<Array<{ status: 'fulfilled'; value: T } | { status: 'rejected'; reason: unknown }>> {
  const sem = new Semaphore(limit);

  const wrapped = tasks.map(task =>
    sem.run(async () => {
      const result = await task();
      if (delayMs > 0) await sleep(delayMs);
      return result;
    })
  );

  return Promise.allSettled(wrapped);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
