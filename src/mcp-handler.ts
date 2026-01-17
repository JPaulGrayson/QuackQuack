/**
 * Quack MCP Handler - Fixed for mcp-remote compatibility
 * Handles the Model Context Protocol over Server-Sent Events
 */

import { Request, Response } from 'express';
import { 
  sendMessage, 
  checkInbox, 
  receiveMessage, 
  completeMessage,
  getMessage 
} from './store.js';
import { SendMessageRequest } from './types.js';

// Store active SSE connections by connectionId
const sseConnections: Map<string, Response> = new Map();

// Send SSE event to a specific connection
function sendSSE(res: Response, event: string, data: any): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

// Handle new SSE connection from mcp-remote
export function handleMCPSSE(req: Request, res: Response): void {
  console.log('🔌 SSE endpoint hit!');
  res.write('event: ping\ndata: test\n\n');
  
  const connectionId = `conn_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  
  console.log(`🔌 MCP client connecting: ${connectionId}`);
  
  // Set up SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  
  // Store the connection
  sseConnections.set(connectionId, res);
  
  // Send the endpoint URL for mcp-remote to POST messages to
  sendSSE(res, 'endpoint', {
    endpoint: `/api/mcp/message?connectionId=${connectionId}`
  });
  
  // Keep connection alive with periodic pings
  const pingInterval = setInterval(() => {
    if (sseConnections.has(connectionId)) {
      res.write(': ping\n\n');
    }
  }, 30000);
  
  // Handle client disconnect
  req.on('close', () => {
    console.log(`🔌 MCP client disconnected: ${connectionId}`);
    clearInterval(pingInterval);
    sseConnections.delete(connectionId);
  });
}

// Handle incoming MCP JSON-RPC messages
export function handleMCPMessage(req: Request, res: Response): void {
  const connectionId = req.query.connectionId as string;
  const sseRes = sseConnections.get(connectionId);
  
  if (!sseRes) {
    console.error(`No SSE connection found for: ${connectionId}`);
    res.status(400).json({ error: 'Invalid connection ID' });
    return;
  }
  
  const message = req.body;
  console.log(`📨 MCP message received:`, message.method || message.id);
  
  // Process the JSON-RPC message
  const response = processMCPMessage(message);
  
  // Send response via SSE
  if (response) {
    sendSSE(sseRes, 'message', response);
  }
  
  // Also respond to the POST
  res.json({ received: true });
}

// Process MCP JSON-RPC messages
function processMCPMessage(message: any): any {
  const { method, params, id } = message;
  
  // Handle notifications (no response needed)
  if (!id && method === 'notifications/initialized') {
    return null;
  }
  
  switch (method) {
    case 'initialize':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          serverInfo: {
            name: 'quack',
            version: '1.0.0',
          },
          capabilities: {
            tools: {},
          },
        },
      };
      
    case 'tools/list':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          tools: [
            {
              name: 'quack_send',
              description: 'Send a message with files and context to another AI agent (replit, cursor, gemini, gpt, or custom)',
              inputSchema: {
                type: 'object',
                properties: {
                  to: { type: 'string', description: 'Destination: replit, cursor, gemini, gpt, or custom name' },
                  task: { type: 'string', description: 'What the receiving agent should do' },
                  context: { type: 'string', description: 'Background information' },
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
                  inbox: { type: 'string', description: 'Inbox to check: claude, replit, cursor, etc.' },
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
          ],
        },
      };
      
    case 'tools/call':
      return handleToolCall(id, params.name, params.arguments || {});
      
    default:
      // For unknown methods, return empty result
      if (id) {
        return {
          jsonrpc: '2.0',
          id,
          result: {},
        };
      }
      return null;
  }
}

// Handle tool calls
function handleToolCall(id: string, toolName: string, args: any): any {
  console.log(`🔧 Tool call: ${toolName}`, args);
  
  try {
    let result: any;
    
    switch (toolName) {
      case 'quack_send': {
        const request: SendMessageRequest = {
          to: args.to,
          from: 'claude',
          task: args.task,
          context: args.context,
          files: args.files || [],
        };
        
        const message = sendMessage(request, 'claude');
        result = {
          success: true,
          messageId: message.id,
          message: `✅ Message sent to /${args.to}. They can check their inbox to see it.`,
        };
        break;
      }
      
      case 'quack_check': {
        const messages = checkInbox(args.inbox, false);
        result = {
          inbox: args.inbox,
          count: messages.length,
          messages: messages.map(m => ({
            id: m.id,
            from: m.from,
            task: m.task,
            timestamp: m.timestamp,
            fileCount: m.files.length,
          })),
        };
        break;
      }
      
      case 'quack_receive': {
        const message = receiveMessage(args.messageId);
        if (!message) {
          result = { error: 'Message not found' };
        } else {
          result = { success: true, message };
        }
        break;
      }
      
      case 'quack_complete': {
        const message = completeMessage(args.messageId);
        if (!message) {
          result = { error: 'Message not found' };
        } else {
          result = { success: true, messageId: message.id };
        }
        break;
      }
      
      default:
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Unknown tool: ${toolName}` },
        };
    }
    
    return {
      jsonrpc: '2.0',
      id,
      result: {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      },
    };
  } catch (err) {
    console.error(`Tool error:`, err);
    return {
      jsonrpc: '2.0',
      id,
      error: {
        code: -32000,
        message: err instanceof Error ? err.message : 'Unknown error',
      },
    };
  }
}
