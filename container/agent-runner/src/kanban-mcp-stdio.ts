/**
 * Stdio MCP Server for Kanban board integration.
 * Wraps the kanban HTTP API as structured tools for the container agent.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const BASE_URL = (process.env.KANBAN_URL ?? 'https://kanbantool.schmitzplex.com').replace(/\/$/, '');
const API_KEY = process.env.KANBAN_API_KEY ?? '';

async function apiGet(path: string): Promise<unknown> {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { 'X-API-Key': API_KEY },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

async function apiPost(path: string, fields: Record<string, string | number>): Promise<unknown> {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) body.append(k, String(v));
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-API-Key': API_KEY,
    },
    body: body.toString(),
    redirect: 'manual',
  });
  // 2xx = success, 3xx = redirect (server processed and redirected back) = also success
  if (res.status >= 200 && res.status < 400) return { ok: true, status: res.status };
  const text = await res.text();
  throw new Error(`HTTP ${res.status}: ${text}`);
}

function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

function err(e: unknown) {
  return {
    content: [{ type: 'text' as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }],
    isError: true,
  };
}

const server = new McpServer({ name: 'kanban', version: '1.0.0' });

server.tool(
  'kanban_get_cards',
  'Get cards on the kanban board. Optionally filter by category slug and/or due date. DueOn.Valid=false means no due date set.',
  {
    category: z.string().optional().describe('Filter by category slug (e.g. "personal", "work"). Omit for all categories.'),
    due_filter: z.enum(['today', 'past_due', 'upcoming', 'has_due_date']).optional().describe(
      'Filter by due date: "today" = due today, "past_due" = overdue, "upcoming" = due in future, "has_due_date" = any due date set.'
    ),
  },
  async (args) => {
    try {
      const cards = await apiGet('/api/cards') as Array<Record<string, unknown>>;
      let filtered = cards;

      if (args.category) {
        filtered = filtered.filter((c) => c['Category'] === args.category || c['category'] === args.category);
      }

      if (args.due_filter) {
        const now = new Date();
        const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const todayEnd = new Date(todayStart.getTime() + 86400000);

        filtered = filtered.filter((c) => {
          const due = c['DueOn'] as { Valid?: boolean; Time?: string } | undefined;
          if (!due?.Valid || !due.Time) return false;
          const dueDate = new Date(due.Time);
          switch (args.due_filter) {
            case 'today':      return dueDate >= todayStart && dueDate < todayEnd;
            case 'past_due':   return dueDate < todayStart;
            case 'upcoming':   return dueDate >= todayEnd;
            case 'has_due_date': return true;
          }
        });
      }

      return ok(filtered);
    } catch (e) { return err(e); }
  },
);

server.tool(
  'kanban_get_categories',
  'Get all categories (rows) on the kanban board, including their slugs. Call this before creating or moving a card to know the valid category slugs.',
  {},
  async () => {
    try { return ok(await apiGet('/api/categories')); } catch (e) { return err(e); }
  },
);

server.tool(
  'kanban_get_statuses',
  'Get all statuses (columns) on the kanban board, including their slugs. Call this before creating or moving a card to know the valid status slugs.',
  {},
  async () => {
    try { return ok(await apiGet('/api/statuses')); } catch (e) { return err(e); }
  },
);

server.tool(
  'kanban_create_card',
  'Create a new card on the kanban board. Use kanban_get_categories and kanban_get_statuses first to get valid slugs.',
  {
    title: z.string().describe('Card title'),
    category: z.string().describe('Category slug (e.g. "personal", "work")'),
    status: z.string().describe('Status slug (e.g. "todo", "in-progress", "done")'),
    description: z.string().optional().describe('Optional card description'),
    due_on: z.string().optional().describe('Optional due date in YYYY-MM-DD format'),
    subtasks: z.string().optional().describe('Optional subtasks text'),
  },
  async (args) => {
    try {
      const fields: Record<string, string> = {
        title: args.title,
        category: args.category,
        status: args.status,
      };
      if (args.description) fields.description = args.description;
      if (args.due_on) fields.due_on = args.due_on;
      if (args.subtasks) fields.subtasks = args.subtasks;
      return ok(await apiPost('/card', fields));
    } catch (e) { return err(e); }
  },
);

server.tool(
  'kanban_move_card',
  'Move an existing card to a different category and/or status. Use kanban_get_cards to get the card ID, and kanban_get_categories/kanban_get_statuses for valid slugs.',
  {
    id: z.string().describe('Card ID'),
    category: z.string().describe('Target category slug'),
    status: z.string().describe('Target status slug'),
    order: z.number().int().default(0).describe('Position within the column (0 = top)'),
  },
  async (args) => {
    try {
      return ok(await apiPost(`/card/${args.id}/move`, {
        category: args.category,
        status: args.status,
        order: args.order,
      }));
    } catch (e) { return err(e); }
  },
);

server.tool(
  'kanban_set_due_date',
  'Set or clear the due date on an existing card. Use kanban_get_cards to get the card ID.',
  {
    id: z.string().describe('Card ID'),
    due_on: z.string().nullable().describe('Due date in YYYY-MM-DD format, or null to clear the due date'),
  },
  async (args) => {
    try {
      return ok(await apiPost(`/card/${args.id}/update`, {
        due_on: args.due_on ?? '',
      }));
    } catch (e) { return err(e); }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
