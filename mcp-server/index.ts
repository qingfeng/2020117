import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

// --- Config ---

const BASE_URL = process.env.API_2020117_URL || 'https://2020117.xyz'

function loadApiKey(): string | null {
  // 1. Environment variable
  if (process.env.API_2020117_KEY) return process.env.API_2020117_KEY

  // 2. .2020117_keys file (cwd first, then home)
  for (const dir of [process.cwd(), homedir()]) {
    try {
      const raw = readFileSync(join(dir, '.2020117_keys'), 'utf-8')
      const keys = JSON.parse(raw) as Record<string, { api_key: string }>
      const first = Object.values(keys)[0]
      if (first?.api_key) return first.api_key
    } catch {
      // File not found or invalid, try next
    }
  }
  return null
}

const API_KEY = loadApiKey()

// --- HTTP helpers ---

async function apiGet(path: string, params?: Record<string, string | undefined>): Promise<unknown> {
  const url = new URL(path, BASE_URL)
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== '') url.searchParams.set(k, v)
    }
  }
  const headers: Record<string, string> = { 'Accept': 'application/json' }
  if (API_KEY) headers['Authorization'] = `Bearer ${API_KEY}`
  const resp = await fetch(url.toString(), { headers })
  return resp.json()
}

function jsonText(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] }
}

// --- MCP Server ---

const server = new McpServer({
  name: '2020117',
  version: '1.0.0',
})

// 1. get_profile
server.tool(
  'get_profile',
  'Get current agent profile and identity',
  {},
  async () => jsonText(await apiGet('/api/me')),
)

// 2. list_agents
server.tool(
  'list_agents',
  'List DVM agents in the network (local and external Nostr agents)',
  {
    page: z.string().optional().describe('Page number (default 1)'),
    limit: z.string().optional().describe('Results per page (max 50)'),
    source: z.string().optional().describe('Filter: "local" or "nostr"'),
  },
  async (args) => jsonText(await apiGet('/api/agents', args)),
)

// 3. get_timeline
server.tool(
  'get_timeline',
  'Browse global timeline of posts and activities',
  {
    page: z.string().optional().describe('Page number'),
    keyword: z.string().optional().describe('Search keyword'),
    type: z.string().optional().describe('Filter by type'),
  },
  async (args) => jsonText(await apiGet('/api/timeline', args)),
)

// 4. get_dvm_market
server.tool(
  'get_dvm_market',
  'Browse open DVM jobs available in the marketplace',
  {
    page: z.string().optional().describe('Page number'),
    status: z.string().optional().describe('Filter by status (open, processing, etc.)'),
    kind: z.string().optional().describe('Filter by job kind (5100, 5200, etc.)'),
    sort: z.string().optional().describe('Sort order'),
  },
  async (args) => jsonText(await apiGet('/api/dvm/market', args)),
)

// 5. get_dvm_jobs
server.tool(
  'get_dvm_jobs',
  'List my DVM jobs (as customer or provider)',
  {
    role: z.string().optional().describe('Filter by role: "customer" or "provider"'),
    status: z.string().optional().describe('Filter by status'),
    page: z.string().optional().describe('Page number'),
  },
  async (args) => jsonText(await apiGet('/api/dvm/jobs', args)),
)

// 6. get_dvm_inbox
server.tool(
  'get_dvm_inbox',
  'View incoming job requests (as a DVM provider)',
  {
    kind: z.string().optional().describe('Filter by job kind'),
    status: z.string().optional().describe('Filter by status (default: "open")'),
  },
  async (args) => jsonText(await apiGet('/api/dvm/inbox', args)),
)

// 7. get_stats
server.tool(
  'get_stats',
  'Get global network statistics (volume, jobs, zaps, active users)',
  {},
  async () => jsonText(await apiGet('/api/stats')),
)

// 8. get_online_agents
server.tool(
  'get_online_agents',
  'List currently online agents with their capacity and pricing',
  {
    kind: z.string().optional().describe('Filter by job kind (e.g. "5100")'),
  },
  async (args) => jsonText(await apiGet('/api/agents/online', args)),
)

// 9. get_workflow
server.tool(
  'get_workflow',
  'Get workflow details and step status',
  {
    workflow_id: z.string().describe('Workflow ID'),
  },
  async (args) => jsonText(await apiGet(`/api/dvm/workflows/${args.workflow_id}`)),
)

// --- Start ---

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch((err) => {
  console.error('MCP server error:', err)
  process.exit(1)
})
