/**
 * @quack/core - Type Definitions
 * Core types for the Quack agent-to-agent relay system
 */

export type AgentType = 'claude' | 'replit' | 'cursor' | 'gemini' | 'gpt' | 'grok' | 'copilot' | 'antigravity' | 'custom';

export type MessageStatus = 'pending' | 'approved' | 'in_progress' | 'read' | 'completed' | 'failed' | 'expired';

export const VALID_STATUSES: MessageStatus[] = ['pending', 'approved', 'in_progress', 'read', 'completed', 'failed'];

export const STATUS_TRANSITIONS: Record<string, string[]> = {
  'pending': ['approved', 'failed'],
  'approved': ['in_progress', 'failed'],
  'in_progress': ['completed', 'failed'],
  'read': ['in_progress'],
  'completed': [],
  'failed': ['pending'],
};

export interface QuackFile {
  name: string;
  content: string;
  type: 'code' | 'doc' | 'image' | 'data';
  mimeType?: string;
  size: number;
}

export interface QuackMessage {
  id: string;
  to: AgentType | string;
  from: AgentType | string;
  timestamp: string;
  expiresAt: string;
  status: MessageStatus;
  readAt?: string;
  task: string;
  context?: string;
  files: QuackFile[];
  projectName?: string;
  conversationExcerpt?: string;
  replyTo?: string;
}

export interface SendMessageRequest {
  to: AgentType | string;
  from: AgentType | string;
  task: string;
  context?: string;
  files?: QuackFile[];
  fileRefs?: string[];
  projectName?: string;
  conversationExcerpt?: string;
  replyTo?: string;
}

export interface InboxResponse {
  inbox: string;
  messages: QuackMessage[];
  count: number;
}

export interface SendResponse {
  success: boolean;
  messageId: string;
  message: QuackMessage;
}

export interface QuackStats {
  inboxes: number;
  messages: number;
  pending: number;
}

export const MCP_TOOLS = {
  quack_send: {
    name: 'quack_send',
    description: 'Send a message with files and context to another AI agent',
    inputSchema: {
      type: 'object',
      properties: {
        to: {
          type: 'string',
          description: 'Destination agent: claude, replit, cursor, gemini, gpt, grok, copilot, antigravity, or custom name',
        },
        task: {
          type: 'string',
          description: 'What the receiving agent should do',
        },
        context: {
          type: 'string',
          description: 'Background information or conversation summary',
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
          description: 'Files to attach',
        },
        projectName: {
          type: 'string',
          description: 'Optional project name for organization',
        },
        conversationExcerpt: {
          type: 'string',
          description: 'Relevant conversation history',
        },
      },
      required: ['to', 'task'],
    },
  },
  
  quack_check: {
    name: 'quack_check',
    description: 'Check for pending messages in an inbox',
    inputSchema: {
      type: 'object',
      properties: {
        inbox: {
          type: 'string',
          description: 'Inbox to check: claude, replit, cursor, gemini, gpt, grok, copilot, antigravity, or custom name',
        },
        includeRead: {
          type: 'boolean',
          description: 'Include already-read messages (default: false)',
        },
      },
      required: ['inbox'],
    },
  },
  
  quack_receive: {
    name: 'quack_receive',
    description: 'Get a specific message and mark it as read',
    inputSchema: {
      type: 'object',
      properties: {
        messageId: {
          type: 'string',
          description: 'ID of the message to receive',
        },
      },
      required: ['messageId'],
    },
  },
  
  quack_complete: {
    name: 'quack_complete',
    description: 'Mark a message as completed',
    inputSchema: {
      type: 'object',
      properties: {
        messageId: {
          type: 'string',
          description: 'ID of the message to mark complete',
        },
      },
      required: ['messageId'],
    },
  },
  
  quack_reply: {
    name: 'quack_reply',
    description: 'Reply to a message',
    inputSchema: {
      type: 'object',
      properties: {
        messageId: {
          type: 'string',
          description: 'ID of the message to reply to',
        },
        task: {
          type: 'string',
          description: 'Response or update',
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
          description: 'Files to attach to reply',
        },
      },
      required: ['messageId', 'task'],
    },
  },
};
