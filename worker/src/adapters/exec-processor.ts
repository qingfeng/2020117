/**
 * Exec processor — delegates to an external command via stdin/stdout.
 *
 * PROCESSOR=exec:./my-model.sh
 *
 * - verify(): checks the command file exists and is executable
 * - generate(): spawns process, writes prompt to stdin, reads full stdout
 * - generateStream(): same but yields stdout line-by-line
 */

import { spawn } from 'child_process'
import { access, constants } from 'fs/promises'
import type { Processor } from '../processor.js'

export class ExecProcessor implements Processor {
  private cmd: string
  private args: string[]

  constructor(cmdSpec: string) {
    const parts = cmdSpec.split(/\s+/)
    this.cmd = parts[0]
    this.args = parts.slice(1)
  }

  get name(): string {
    return `exec:${this.cmd}`
  }

  async verify(): Promise<void> {
    try {
      await access(this.cmd, constants.X_OK)
    } catch {
      throw new Error(`Exec processor: "${this.cmd}" is not executable or does not exist`)
    }
  }

  generate(prompt: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.cmd, this.args, { stdio: ['pipe', 'pipe', 'pipe'] })
      const chunks: Buffer[] = []
      let stderr = ''

      child.stdout.on('data', (data: Buffer) => chunks.push(data))
      child.stderr.on('data', (data: Buffer) => { stderr += data.toString() })

      child.on('error', (err) => reject(new Error(`Exec spawn error: ${err.message}`)))
      child.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`Exec process exited with code ${code}: ${stderr}`))
        } else {
          resolve(Buffer.concat(chunks).toString('utf-8'))
        }
      })

      child.stdin.write(prompt)
      child.stdin.end()
    })
  }

  async *generateStream(prompt: string): AsyncGenerator<string> {
    const child = spawn(this.cmd, this.args, { stdio: ['pipe', 'pipe', 'pipe'] })

    child.stdin.write(prompt)
    child.stdin.end()

    // Yield stdout line-by-line
    let buffer = ''

    try {
      for await (const data of child.stdout) {
        buffer += data.toString()
        const lines = buffer.split('\n')
        buffer = lines.pop()!
        for (const line of lines) {
          yield line + '\n'
        }
      }
      // Flush remaining
      if (buffer.length > 0) {
        yield buffer
      }
    } finally {
      child.kill()
    }
  }
}
