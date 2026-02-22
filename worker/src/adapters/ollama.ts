/**
 * Ollama adapter — call local LLM via Ollama HTTP API
 *
 * Ollama runs on localhost:11434 by default.
 * Supports streaming for real-time token delivery over Hyperswarm.
 */

const OLLAMA_BASE = process.env.OLLAMA_BASE_URL || 'http://localhost:11434'

export interface OllamaGenerateOptions {
  model?: string
  prompt: string
  system?: string
  temperature?: number
  max_tokens?: number
}

export interface OllamaChunk {
  model: string
  response: string
  done: boolean
}

/**
 * Non-streaming generate — returns complete response
 */
export async function generate(opts: OllamaGenerateOptions): Promise<string> {
  const res = await fetch(`${OLLAMA_BASE}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: opts.model || 'llama3.2',
      prompt: opts.prompt,
      system: opts.system,
      stream: false,
      options: {
        temperature: opts.temperature ?? 0.7,
        num_predict: opts.max_tokens ?? 2048,
      },
    }),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Ollama error ${res.status}: ${text}`)
  }

  const data = await res.json() as any
  return data.response
}

/**
 * Streaming generate — yields tokens as they arrive
 */
export async function* generateStream(opts: OllamaGenerateOptions): AsyncGenerator<string> {
  const res = await fetch(`${OLLAMA_BASE}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: opts.model || 'llama3.2',
      prompt: opts.prompt,
      system: opts.system,
      stream: true,
      options: {
        temperature: opts.temperature ?? 0.7,
        num_predict: opts.max_tokens ?? 2048,
      },
    }),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Ollama error ${res.status}: ${text}`)
  }

  const reader = res.body?.getReader()
  if (!reader) throw new Error('No response body')

  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop()!

    for (const line of lines) {
      if (!line.trim()) continue
      const chunk: OllamaChunk = JSON.parse(line)
      if (chunk.response) {
        yield chunk.response
      }
    }
  }
}

/**
 * Check if Ollama is running and list available models
 */
export async function listModels(): Promise<string[]> {
  const res = await fetch(`${OLLAMA_BASE}/api/tags`)
  if (!res.ok) throw new Error(`Ollama not reachable at ${OLLAMA_BASE}`)
  const data = await res.json() as any
  return (data.models || []).map((m: any) => m.name)
}
