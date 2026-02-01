/**
 * Quack - Agent-to-Agent Relay Types
 * 🦆 Send your work from one AI agent to another
 */

// Supported agent types
export type AgentType = 'claude' | 'replit' | 'cursor' | 'gemini' | 'gpt' | 'grok' | 'copilot' | 'antigravity' | 'custom';

// Message status (expanded for Orchestrate integration)
export type MessageStatus = 'pending' | 'approved' | 'in_progress' | 'read' | 'completed' | 'failed' | 'expired';

// Valid statuses for API updates
export const VALID_STATUSES: MessageStatus[] = ['pending', 'approved', 'in_progress', 'read', 'completed', 'failed'];

// ============== Control Messages (OpenClaw-inspired) ==============
// Control messages allow agents to signal conversation state changes

export type ControlMessageType = 
  | 'REPLY_SKIP'        // Agent signals: "I'm done, don't expect a reply"
  | 'ANNOUNCE_SKIP'     // Agent signals: "Don't announce this to channel"
  | 'CONVERSATION_END'; // Agent signals: "This conversation is complete"

export type ThreadStatus = 'active' | 'completed' | 'abandoned';

// ============== End Control Messages ==============

// File attachment
export interface QuackFile {
  name: string;
  content: string;      // base64 encoded for binary, raw for text
  type: 'code' | 'doc' | 'image' | 'data';
  mimeType?: string;
  size: number;         // bytes
}

// Message priority levels
export type MessagePriority = 'low' | 'normal' | 'high' | 'urgent';

// Routing types for CoWork
export type RoutingType = 'direct' | 'cowork';

// Agent category for CoWork routing
export type AgentCategory = 'conversational' | 'autonomous' | 'supervised';

// Agent configuration for CoWork
export interface AgentConfig {
  name: string;                    // agent identifier (e.g., "claude", "replit")
  category: AgentCategory;         // how messages are handled
  requiresApproval: boolean;       // needs human approval?
  autoApproveOnCheck: boolean;     // auto-approve when agent polls inbox
  notifyVia: 'polling' | 'webhook' | 'websocket';
  webhookUrl?: string;             // for webhook notifications
  platformUrl?: string;            // URL to open when notifying agent (e.g., "https://replit.com/@paul/quack")
  notifyPrompt?: string;           // Prompt text to paste when notifying agent
  lastActivity?: string;           // ISO 8601 timestamp of last activity
  registeredAt: string;            // ISO 8601 timestamp
}

// Core message format
export interface QuackMessage {
  id: string;
  to: AgentType | string;       // destination inbox
  from: AgentType | string;     // sender
  timestamp: string;            // ISO 8601
  expiresAt: string;            // ISO 8601, 48 hours from creation
  status: MessageStatus;
  readAt?: string;              // when message was read
  
  // Content
  task: string;                 // what to do
  context?: string;             // background info
  files: QuackFile[];           // attachments
  
  // Optional metadata
  projectName?: string;
  conversationExcerpt?: string;
  
  // New metadata fields (per Claude's spec)
  project?: string;             // project identifier for filtering
  priority?: MessagePriority;   // message priority
  tags?: string[];              // arbitrary tags for organization
  
  // CoWork routing
  routing?: RoutingType;        // 'direct' (default) or 'cowork'
  routedAt?: string;            // when message was routed via CoWork
  destination?: string;         // final recipient when routed via CoWork
  coworkStatus?: 'pending' | 'approved' | 'rejected' | 'forwarded';  // CoWork routing status
  
  // Threading
  replyTo?: string;             // message ID this is replying to
  threadId?: string;            // thread ID linking conversation
  replyCount?: number;          // number of replies to this message

  // Control flow (OpenClaw-inspired)
  isControlMessage?: boolean;
  controlType?: ControlMessageType;
  threadStatus?: ThreadStatus;
}

// CoWork routing action
export type CoWorkRouteAction = 'approve' | 'reject' | 'forward';

// API request types
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
  threadId?: string;            // optional: specify existing thread
  // New metadata fields (per Claude's spec)
  project?: string;             // project identifier for filtering
  priority?: MessagePriority;   // message priority (low/normal/high/urgent)
  tags?: string[];              // arbitrary tags for organization
  // CoWork routing
  routing?: RoutingType;        // 'direct' (default) or 'cowork'
  destination?: string;         // final recipient when to='cowork'
  // Override auto-approval
  requireApproval?: boolean;    // force message to pending status (skip auto-approve)
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

// MCP tool schemas
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
        project: {
          type: 'string',
          description: 'Project identifier for filtering and organization',
        },
        priority: {
          type: 'string',
          enum: ['low', 'normal', 'high', 'urgent'],
          description: 'Message priority level',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tags for categorization and filtering',
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
