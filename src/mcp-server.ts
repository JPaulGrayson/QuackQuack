#!/usr/bin/env node
/**
 * Quack MCP Server (Standalone)
 * 
 * For Claude Desktop config:
 * {
 *   "mcpServers": {
 *     "quack": {
 *       "command": "npx",
 *       "args": ["-y", "mcp-remote", "https://your-quack-url/api/mcp/sse"]
 *     }
 *   }
 * }
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const QUACK_SERVER = process.env.QUACK_SERVER || 'http://localhost:3000';

// Create MCP server
const server = new Server(
  { name: 'quack', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'quack_send',
      description: 'Send a message with files and context to another AI agent',
      inputSchema: {
        type: 'object',
        properties: {
          to: {
            type: 'string',
            description: 'Destination agent: claude, replit, cursor, gemini, gpt, grok, copilot',
          },
          task: {
            type: 'string',
            description: 'What the receiving agent should do',
          },
          context: {
            type: 'string',
            description: 'Background information',
          },
          files: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                content: { type: 'string' },
                type: { type: 'string', enum: ['code', 'doc', 'image', 'data'] },
              },
              required: ['name', 'content', 'type'],
            },
          },
          projectName: { type: 'string' },
          conversationExcerpt: { type: 'string' },
        },
        required: ['to', 'task'],
      },
    },
    {
      name: 'quack_check',
      description: 'Check for pending messages in an inbox',
      inputSchema: {
        type: 'object',
        properties: {
          inbox: {
            type: 'string',
            description: 'Inbox to check: claude, replit, cursor, gemini, gpt, grok, copilot',
          },
          includeRead: {
            type: 'boolean',
            description: 'Include already-read messages',
          },
        },
        required: ['inbox'],
      },
    },
    {
      name: 'quack_receive',
      description: 'Get a specific message and mark it as read',
      inputSchema: {
        type: 'object',
        properties: {
          messageId: { type: 'string' },
        },
        required: ['messageId'],
      },
    },
    {
      name: 'quack_complete',
      description: 'Mark a message as completed',
      inputSchema: {
        type: 'object',
        properties: {
          messageId: { type: 'string' },
        },
        required: ['messageId'],
      },
    },
    {
      name: 'quack_reply',
      description: 'Reply to a message',
      inputSchema: {
        type: 'object',
        properties: {
          messageId: { type: 'string' },
          task: { type: 'string' },
          files: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                content: { type: 'string' },
                type: { type: 'string' },
              },
            },
          },
        },
        required: ['messageId', 'task'],
      },
    },
  ],
}));

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  
  try {
    let endpoint: string;
    let method = 'GET';
    let body: any;
    
    switch (name) {
      case 'quack_send':
        endpoint = '/api/send';
        method = 'POST';
        body = {
          to: args.to,
          from: 'claude',
          task: args.task,
          context: args.context,
          files: args.files || [],
          projectName: args.projectName,
          conversationExcerpt: args.conversationExcerpt,
        };
        break;
        
      case 'quack_check':
        endpoint = `/api/inbox/${args.inbox}?includeRead=${args.includeRead || false}`;
        break;
        
      case 'quack_receive':
        endpoint = `/api/receive/${args.messageId}`;
        method = 'POST';
        break;
        
      case 'quack_complete':
        endpoint = `/api/complete/${args.messageId}`;
        method = 'POST';
        break;
        
      case 'quack_reply':
        // First get the original message to find the sender
        const msgRes = await fetch(`${QUACK_SERVER}/api/message/${args.messageId}`);
        const original = await msgRes.json();
        
        endpoint = '/api/send';
        method = 'POST';
        body = {
          to: original.from,
          from: original.to,
          task: args.task,
          files: args.files || [],
          replyTo: args.messageId,
        };
        break;
        
      default:
        return {
          content: [{ type: 'text', text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
    
    const fetchOptions: RequestInit = {
      method,
      headers: { 'Content-Type': 'application/json' },
    };
    
    if (body) {
      fetchOptions.body = JSON.stringify(body);
    }
    
    const response = await fetch(`${QUACK_SERVER}${endpoint}`, fetchOptions);
    const result = await response.json();
    
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error: ${err}` }],
      isError: true,
    };
  }
});

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('🦆 Quack MCP server running');
}

main().catch(console.error);
