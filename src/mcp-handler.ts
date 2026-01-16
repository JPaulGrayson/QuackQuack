/**
 * MCP Handler for Quack
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
import { MCP_TOOLS, SendMessageRequest } from './types.js';

// Active SSE connections
const connections: Map<string, Response> = new Map();

// Send SSE message
function sendSSE(res: Response, event: string, data: any): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

// Handle MCP connection
export function handleMCPConnection(req: Request, res: Response): void {
  const connectionId = Date.now().toString();
  connections.set(connectionId, res);
  
  // Send initial server info
  sendSSE(res, 'endpoint', {
    endpoint: `/api/mcp/message?connectionId=${connectionId}`
  });
  
  // Handle client disconnect
  req.on('close', () => {
    connections.delete(connectionId);
    console.log('🔌 MCP client disconnected');
  });
}

// Handle MCP JSON-RPC messages
export function handleMCPMessage(connectionId: string, message: any): any {
  const { method, params, id } = message;
  
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
          tools: Object.values(MCP_TOOLS),
        },
      };
      
    case 'tools/call':
      return handleToolCall(id, params.name, params.arguments);
      
    default:
      return {
        jsonrpc: '2.0',
        id,
        error: {
          code: -32601,
          message: `Method not found: ${method}`,
        },
      };
  }
}

// Handle tool calls
function handleToolCall(id: string, toolName: string, args: any): any {
  try {
    let result: any;
    
    switch (toolName) {
      case 'quack_send': {
        const request: SendMessageRequest = {
          to: args.to,
          from: args.from || 'claude',
          task: args.task,
          context: args.context,
          files: args.files || [],
          projectName: args.projectName,
          conversationExcerpt: args.conversationExcerpt,
        };
        
        const message = sendMessage(request, 'claude');
        result = {
          success: true,
          messageId: message.id,
          message: `Message sent to /${args.to}. The receiving agent can check their inbox to see it.`,
        };
        break;
      }
      
      case 'quack_check': {
        const messages = checkInbox(args.inbox, args.includeRead || false);
        result = {
          inbox: args.inbox,
          count: messages.length,
          messages: messages.map(m => ({
            id: m.id,
            from: m.from,
            task: m.task,
            timestamp: m.timestamp,
            status: m.status,
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
          result = {
            success: true,
            message,
          };
        }
        break;
      }
      
      case 'quack_complete': {
        const message = completeMessage(args.messageId);
        if (!message) {
          result = { error: 'Message not found' };
        } else {
          result = {
            success: true,
            messageId: message.id,
          };
        }
        break;
      }
      
      case 'quack_reply': {
        const original = getMessage(args.messageId);
        if (!original) {
          result = { error: 'Original message not found' };
        } else {
          const request: SendMessageRequest = {
            to: original.from, // Reply goes back to sender
            from: original.to, // From the original recipient
            task: args.task,
            files: args.files || [],
            replyTo: args.messageId,
          };
          
          const reply = sendMessage(request, original.to as string);
          result = {
            success: true,
            messageId: reply.id,
            message: `Reply sent to /${original.from}`,
          };
        }
        break;
      }
      
      default:
        return {
          jsonrpc: '2.0',
          id,
          error: {
            code: -32601,
            message: `Unknown tool: ${toolName}`,
          },
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
