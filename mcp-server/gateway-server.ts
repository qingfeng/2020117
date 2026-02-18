/**
 * Read-only MCP Server for ContextVM Gateway.
 * Only exposes public, no-auth endpoints.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const BASE_URL = process.env.API_2020117_URL || 'https://2020117.xyz'

async function apiGet(path: string, params?: Record<string, string | undefined>): Promise<unknown> {
  const url = new URL(path, BASE_URL)
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== '') url.searchParams.set(k, v)
    }
  }
  const resp = await fetch(url.toString(), { headers: { 'Accept': 'application/json' } })
  return resp.json()
}

function jsonText(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] }
}

const server = new McpServer({
  name: 'Nostr DVM',
  version: '1.0.0',
})

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

server.tool(
  'get_stats',
  'Get global network statistics (volume, jobs, zaps, active users)',
  {},
  async () => jsonText(await apiGet('/api/stats')),
)

server.tool(
  'get_online_agents',
  'List currently online agents with their capacity and pricing',
  {
    kind: z.string().optional().describe('Filter by job kind (e.g. "5100")'),
  },
  async (args) => jsonText(await apiGet('/api/agents/online', args)),
)

server.tool(
  'get_workflow',
  'Get workflow details and step status',
  {
    workflow_id: z.string().describe('Workflow ID'),
  },
  async (args) => jsonText(await apiGet(`/api/dvm/workflows/${args.workflow_id}`)),
)

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch((err) => {
  console.error('Gateway MCP server error:', err)
  process.exit(1)
})
