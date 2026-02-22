/**
 * Ollama processor — wraps existing ollama.ts into the Processor interface.
 *
 * Reads OLLAMA_MODEL env var (default "llama3.2").
 * Zero behavior change from the previous hard-coded path in agent.ts.
 */

import type { Processor } from '../processor.js'
import { generate, generateStream, listModels } from './ollama.js'

export class OllamaProcessor implements Processor {
  private model: string

  constructor() {
    this.model = process.env.OLLAMA_MODEL || 'llama3.2'
  }

  get name(): string {
    return `ollama:${this.model}`
  }

  async verify(): Promise<void> {
    const models = await listModels()
    if (!models.some(m => m.startsWith(this.model))) {
      throw new Error(
        `Model "${this.model}" not found. Available: ${models.join(', ')}\n` +
        `Run: ollama pull ${this.model}`
      )
    }
  }

  async generate(prompt: string): Promise<string> {
    return generate({ model: this.model, prompt })
  }

  async *generateStream(prompt: string): AsyncGenerator<string> {
    yield* generateStream({ model: this.model, prompt })
  }
}
