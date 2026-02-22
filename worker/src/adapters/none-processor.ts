/**
 * None processor — pure pass-through, no local model needed.
 *
 * Use case: broker agents that receive tasks and delegate to sub-providers.
 * generate() returns the prompt as-is so the pipeline can forward it.
 */

import type { Processor } from '../processor.js'

export class NoneProcessor implements Processor {
  readonly name = 'none'

  async verify(): Promise<void> {
    // No-op — nothing to check
  }

  async generate(prompt: string): Promise<string> {
    return prompt
  }

  async *generateStream(prompt: string): AsyncGenerator<string> {
    yield prompt
  }
}
