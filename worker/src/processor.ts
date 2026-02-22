/**
 * Processor interface — abstraction over the compute backend.
 *
 * agent.ts talks only to Processor; the actual backend is selected at
 * startup via the PROCESSOR env var:
 *
 *   PROCESSOR=ollama        (default) — local Ollama
 *   PROCESSOR=none          — pass-through, no model needed
 *   PROCESSOR=exec:./cmd    — stdin/stdout child process
 *   PROCESSOR=http://url    — remote HTTP endpoint
 */

export interface Processor {
  /** Human-readable name for logs (e.g. "ollama:llama3.2", "none") */
  readonly name: string
  /** Startup check — may throw to abort launch */
  verify(): Promise<void>
  /** Non-streaming generation */
  generate(prompt: string): Promise<string>
  /** Streaming generation — yields chunks as they arrive */
  generateStream(prompt: string): AsyncGenerator<string>
}

/**
 * Factory — reads PROCESSOR env var and returns the appropriate backend.
 */
export async function createProcessor(): Promise<Processor> {
  const spec = process.env.PROCESSOR || 'ollama'

  if (spec === 'none') {
    const { NoneProcessor } = await import('./adapters/none-processor.js')
    return new NoneProcessor()
  }

  if (spec === 'ollama') {
    const { OllamaProcessor } = await import('./adapters/ollama-processor.js')
    return new OllamaProcessor()
  }

  if (spec.startsWith('exec:')) {
    const cmd = spec.slice('exec:'.length)
    const { ExecProcessor } = await import('./adapters/exec-processor.js')
    return new ExecProcessor(cmd)
  }

  if (spec.startsWith('http://') || spec.startsWith('https://')) {
    const { HttpProcessor } = await import('./adapters/http-processor.js')
    return new HttpProcessor(spec)
  }

  throw new Error(`Unknown PROCESSOR value: "${spec}". Use: none | ollama | exec:<cmd> | http(s)://<url>`)
}
