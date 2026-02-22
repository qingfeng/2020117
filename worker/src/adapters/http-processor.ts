/**
 * HTTP processor — delegates to a remote HTTP endpoint.
 *
 * PROCESSOR=http://localhost:8080/generate
 *
 * - verify(): HEAD request to check endpoint is reachable
 * - generate(): POST JSON { prompt }, reads result/data/output field
 * - generateStream(): POST with Accept: application/x-ndjson, yields lines
 */

import type { Processor } from '../processor.js'

export class HttpProcessor implements Processor {
  private url: string

  constructor(url: string) {
    this.url = url
  }

  get name(): string {
    return `http:${this.url}`
  }

  async verify(): Promise<void> {
    try {
      const res = await fetch(this.url, { method: 'HEAD' })
      // Accept any response — we just need to know it's reachable
      if (!res.ok && res.status !== 405) {
        throw new Error(`HTTP ${res.status}`)
      }
    } catch (e: any) {
      throw new Error(`HTTP processor: endpoint not reachable at ${this.url}: ${e.message}`)
    }
  }

  async generate(prompt: string): Promise<string> {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt }),
    })

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`HTTP processor error ${res.status}: ${text}`)
    }

    const data = await res.json() as Record<string, any>
    // Try common field names
    const output = data.result ?? data.data ?? data.output ?? data.text ?? data.response
    if (output === undefined) {
      throw new Error(`HTTP processor: response has no result/data/output/text/response field`)
    }
    return String(output)
  }

  async *generateStream(prompt: string): AsyncGenerator<string> {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/x-ndjson',
      },
      body: JSON.stringify({ prompt }),
    })

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`HTTP processor stream error ${res.status}: ${text}`)
    }

    const reader = res.body?.getReader()
    if (!reader) throw new Error('HTTP processor: no response body')

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
        try {
          const obj = JSON.parse(line)
          const chunk = obj.chunk ?? obj.data ?? obj.text ?? obj.token ?? obj.response
          if (chunk !== undefined) {
            yield String(chunk)
          }
        } catch {
          // Not JSON — yield raw line
          yield line
        }
      }
    }

    // Flush remaining
    if (buffer.trim()) {
      try {
        const obj = JSON.parse(buffer)
        const chunk = obj.chunk ?? obj.data ?? obj.text ?? obj.token ?? obj.response
        if (chunk !== undefined) yield String(chunk)
      } catch {
        yield buffer
      }
    }
  }
}
