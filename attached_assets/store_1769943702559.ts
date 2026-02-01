/**
 * Quack Message Store
 * In-memory store with JSON file persistence
 * Messages expire after 48 hours or when read
 */

import { v4 as uuid } from 'uuid';
import fs from 'fs';
import path from 'path';
import { 
  QuackMessage, 
  QuackFile, 
  SendMessageRequest, 
  MessageStatus,
  ControlMessageType
} from './types.js';
import { shouldAutoApprove as coworkShouldAutoApprove } from './cowork-store.js';
import { logAudit, archiveThread } from './db.js';

const STORE_FILE = './data/messages.json';
const TTL_HOURS = 48;

// In-memory message store
// Key: inbox name, Value: array of messages
const inboxes: Map<string, QuackMessage[]> = new Map();

// Initialize store from file
export function initStore(): void {
  try {
    const dir = path.dirname(STORE_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    
    if (fs.existsSync(STORE_FILE)) {
      const data = JSON.parse(fs.readFileSync(STORE_FILE, 'utf-8'));
      for (const [inbox, messages] of Object.entries(data)) {
        inboxes.set(inbox, messages as QuackMessage[]);
      }
      console.log(`📦 Loaded ${inboxes.size} inboxes from store`);
    }
  } catch (err) {
    console.error('Failed to load store:', err);
  }
  
  // Run cleanup every hour
  setInterval(cleanupExpired, 60 * 60 * 1000);
  cleanupExpired();
}

// Persist store to file
function persistStore(): void {
  try {
    const data: Record<string, QuackMessage[]> = {};
    for (const [inbox, messages] of inboxes) {
      data[inbox] = messages;
    }
    fs.writeFileSync(STORE_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('Failed to persist store:', err);
  }
}

// Clean up expired messages and empty inboxes
// Archives completed threads before removal
async function cleanupExpired(): Promise<void> {
  const now = new Date();
  let cleaned = 0;
  const emptyInboxes: string[] = [];
  const archivedThreads = new Set<string>();
  
  // First pass: collect threads to archive (completed messages about to expire)
  for (const [inbox, messages] of inboxes) {
    for (const msg of messages) {
      const expires = new Date(msg.expiresAt);
      if (expires <= now && msg.status === 'completed' && msg.threadId) {
        if (!archivedThreads.has(msg.threadId)) {
          archivedThreads.add(msg.threadId);
        }
      }
    }
  }
  
  // Archive completed threads before cleanup
  for (const threadId of archivedThreads) {
    try {
      const threadMessages = getThreadMessages(threadId);
      if (threadMessages.length > 0) {
        await archiveThread(threadId, threadMessages, { archivedReason: 'expiration_cleanup' });
        console.log(`📦 Archived thread ${threadId.substring(0, 8)}... (${threadMessages.length} messages)`);
      }
    } catch (e) {
      console.error(`Failed to archive thread ${threadId}:`, e);
    }
  }
  
  // Second pass: remove expired messages
  for (const [inbox, messages] of inboxes) {
    const valid = messages.filter(m => {
      const expires = new Date(m.expiresAt);
      return expires > now;
    });
    
    cleaned += messages.length - valid.length;
    
    if (valid.length === 0) {
      emptyInboxes.push(inbox);
    } else {
      inboxes.set(inbox, valid);
    }
  }
  
  // Remove empty inboxes
  for (const inbox of emptyInboxes) {
    inboxes.delete(inbox);
  }
  
  if (cleaned > 0 || emptyInboxes.length > 0) {
    console.log(`🧹 Cleaned ${cleaned} expired messages, removed ${emptyInboxes.length} empty inboxes`);
    persistStore();
  }
}

// Export cleanup for manual triggering
export function runCleanup(): { cleaned: number; removedInboxes: string[] } {
  const now = new Date();
  let cleaned = 0;
  const emptyInboxes: string[] = [];
  
  for (const [inbox, messages] of inboxes) {
    const valid = messages.filter(m => {
      const expires = new Date(m.expiresAt);
      return expires > now;
    });
    
    cleaned += messages.length - valid.length;
    
    if (valid.length === 0) {
      emptyInboxes.push(inbox);
    } else {
      inboxes.set(inbox, valid);
    }
  }
  
  for (const inbox of emptyInboxes) {
    inboxes.delete(inbox);
  }
  
  if (cleaned > 0 || emptyInboxes.length > 0) {
    persistStore();
  }
  
  return { cleaned, removedInboxes: emptyInboxes };
}

// Normalize inbox path - removes leading slashes and converts to lowercase
function normalizeInboxPath(inbox: string): string {
  return inbox.replace(/^\/+/, '').toLowerCase();
}

// Validate inbox path format
// Root paths like "/claude" are allowed when project metadata is provided
// Otherwise must be platform/application format like "replit/orchestrate"
export function validateInboxPath(to: string, hasProjectMetadata: boolean = false): { valid: boolean; error?: string } {
  const parts = to.split('/').filter(p => p.length > 0);
  
  if (parts.length < 1) {
    return { 
      valid: false, 
      error: `Invalid inbox path "${to}". Cannot be empty.`
    };
  }
  
  // Allow single-level paths (root inboxes) when project metadata is provided
  if (parts.length === 1 && !hasProjectMetadata) {
    return { 
      valid: false, 
      error: `Invalid inbox path "${to}". Messages to root inboxes require project metadata, or use platform/application format (e.g., "replit/orchestrate", "claude/project-alpha").`
    };
  }
  
  if (parts.length > 3) {
    return {
      valid: false,
      error: `Inbox path "${to}" has too many levels. Maximum depth is 3 (platform/application/subtask).`
    };
  }
  
  return { valid: true };
}

// Detect control messages (OpenClaw-inspired)
// These special messages signal conversation state changes
export function detectControlMessage(task: string): { isControl: boolean; type?: ControlMessageType } {
  const trimmed = task.trim().toUpperCase();
  if (trimmed === 'REPLY_SKIP') return { isControl: true, type: 'REPLY_SKIP' };
  if (trimmed === 'ANNOUNCE_SKIP') return { isControl: true, type: 'ANNOUNCE_SKIP' };
  if (trimmed === 'CONVERSATION_END') return { isControl: true, type: 'CONVERSATION_END' };
  return { isControl: false };
}

// Send a message
export function sendMessage(req: SendMessageRequest, fromAgent: string): QuackMessage {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + TTL_HOURS * 60 * 60 * 1000);
  
  // Handle threading
  let threadId = req.threadId;
  let originalMessage: QuackMessage | null = null;
  
  if (req.replyTo) {
    // Find the original message to get/set thread
    originalMessage = getMessage(req.replyTo);
    if (originalMessage) {
      // Use existing threadId or create new one from original message ID
      threadId = originalMessage.threadId || originalMessage.id;
      
      // Update original message with threadId if not set
      if (!originalMessage.threadId) {
        originalMessage.threadId = threadId;
      }
      
      // Increment reply count on original
      originalMessage.replyCount = (originalMessage.replyCount || 0) + 1;
      
      // Auto-complete the original message when a reply is received
      // (only if it's in an actionable state)
      if (['pending', 'approved', 'in_progress'].includes(originalMessage.status)) {
        originalMessage.status = 'completed';
        console.log(`✅ Original message ${originalMessage.id} auto-completed (reply received)`);
      }
    }
  }
  
  const messageId = uuid();
  
  // Check for control messages
  const controlInfo = detectControlMessage(req.task);
  
  // Determine if this is agent-to-agent (autonomous) or needs human approval
  // Uses CoWork agent registry for dynamic configuration
  // Can be overridden with requireApproval flag
  const fromPlatform = (fromAgent || req.from || '').replace(/^\/+/, '').split('/')[0].toLowerCase();
  const toPlatform = req.to.replace(/^\/+/, '').split('/')[0].toLowerCase();
  const wouldAutoApprove = coworkShouldAutoApprove(fromPlatform, toPlatform);
  const shouldApprove = req.requireApproval ? false : wouldAutoApprove;
  
  const message: QuackMessage = {
    id: messageId,
    to: req.to,
    from: fromAgent || req.from,
    timestamp: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    status: shouldApprove ? 'approved' : 'pending',  // Auto-approve unless overridden
    task: req.task,
    context: req.context,
    files: req.files || [],
    projectName: req.projectName,
    conversationExcerpt: req.conversationExcerpt,
    replyTo: req.replyTo,
    threadId: threadId || messageId,  // Root messages get their own ID as threadId
    // New metadata fields
    project: req.project,
    priority: req.priority,
    tags: req.tags,
    // CoWork routing
    routing: req.routing || 'direct',
    routedAt: req.routing === 'cowork' ? now.toISOString() : undefined,
    // Control flow
    isControlMessage: controlInfo.isControl,
    controlType: controlInfo.type,
    threadStatus: controlInfo.type === 'CONVERSATION_END' ? 'completed' : undefined,
  };
  
  // Add file sizes if not present
  message.files = message.files.map(f => ({
    ...f,
    size: f.size || Buffer.byteLength(f.content, 'utf-8'),
  }));
  
  // Get or create inbox - normalize to remove leading slashes
  const inbox = normalizeInboxPath(req.to);
  if (!inboxes.has(inbox)) {
    inboxes.set(inbox, []);
  }
  
  inboxes.get(inbox)!.push(message);
  persistStore();
  
  console.log(`📨 Message ${message.id} sent to /${inbox}${shouldApprove ? ' (auto-approved)' : ''}${threadId ? ` (thread: ${threadId.substring(0, 8)}...)` : ''}${controlInfo.isControl ? ` [CONTROL: ${controlInfo.type}]` : ''}`);
  
  // Audit log
  logAudit('message.send', message.from, 'message', message.id, {
    to: message.to,
    status: message.status,
    threadId: message.threadId,
    priority: message.priority,
    isControlMessage: controlInfo.isControl,
    controlType: controlInfo.type
  }).catch(e => console.error('Audit log failed:', e));
  
  return message;
}

// Check inbox for messages
// By default returns actionable messages (pending, approved, in_progress)
// Use includeRead=true to also see read/completed/failed messages
// Use autoApprove=true to automatically approve pending messages when checked
export function checkInbox(inbox: string, includeRead: boolean = false, autoApprove: boolean = false): QuackMessage[] {
  const messages = inboxes.get(normalizeInboxPath(inbox)) || [];
  
  // Auto-approve pending messages if requested
  if (autoApprove) {
    let approved = 0;
    for (const msg of messages) {
      if (msg.status === 'pending') {
        msg.status = 'approved';
        approved++;
      }
    }
    if (approved > 0) {
      persistStore();
      console.log(`✅ Auto-approved ${approved} message(s) in /${inbox}`);
    }
  }
  
  if (includeRead) {
    return messages;
  }
  
  // Return all actionable messages (not just pending)
  const actionableStatuses = ['pending', 'approved', 'in_progress'];
  return messages.filter(m => actionableStatuses.includes(m.status));
}

// Get a specific message and mark as read
export function receiveMessage(messageId: string): QuackMessage | null {
  for (const [_, messages] of inboxes) {
    const message = messages.find(m => m.id === messageId);
    if (message) {
      message.status = 'read';
      message.readAt = new Date().toISOString();
      persistStore();
      console.log(`📬 Message ${messageId} marked as read`);
      
      // Audit log
      logAudit('message.read', message.to, 'message', messageId, {
        from: message.from,
        threadId: message.threadId
      }).catch(e => console.error('Audit log failed:', e));
      
      return message;
    }
  }
  return null;
}

// Mark message as completed
export function completeMessage(messageId: string): QuackMessage | null {
  for (const [_, messages] of inboxes) {
    const message = messages.find(m => m.id === messageId);
    if (message) {
      message.status = 'completed';
      persistStore();
      console.log(`✅ Message ${messageId} marked as completed`);
      
      // Audit log
      logAudit('message.complete', 'system', 'message', messageId, {
        to: message.to,
        from: message.from,
        threadId: message.threadId
      }).catch(e => console.error('Audit log failed:', e));
      
      return message;
    }
  }
  return null;
}

// Approve a message (for Orchestrate integration)
export function approveMessage(messageId: string): QuackMessage | null {
  for (const [_, messages] of inboxes) {
    const message = messages.find(m => m.id === messageId);
    if (message) {
      if (message.status !== 'pending') {
        return null; // Can only approve pending messages
      }
      message.status = 'approved';
      persistStore();
      console.log(`👍 Message ${messageId} approved`);
      
      // Audit log
      logAudit('message.approve', 'user', 'message', messageId, {
        to: message.to,
        from: message.from,
        threadId: message.threadId
      }).catch(e => console.error('Audit log failed:', e));
      
      return message;
    }
  }
  return null;
}

// Update message status (general purpose)
export function updateMessageStatus(messageId: string, status: MessageStatus): QuackMessage | null {
  for (const [_, messages] of inboxes) {
    const message = messages.find(m => m.id === messageId);
    if (message) {
      const oldStatus = message.status;
      message.status = status;
      persistStore();
      console.log(`📝 Message ${messageId} status updated to: ${status}`);
      
      // Audit log
      logAudit('message.status_change', 'system', 'message', messageId, {
        from: oldStatus,
        to: status,
        msgTo: message.to,
        msgFrom: message.from
      }).catch(e => console.error('Audit log failed:', e));
      
      return message;
    }
  }
  return null;
}

// Get a message by ID
export function getMessage(messageId: string): QuackMessage | null {
  for (const [_, messages] of inboxes) {
    const message = messages.find(m => m.id === messageId);
    if (message) {
      return message;
    }
  }
  return null;
}

// Delete a message by ID
export function deleteMessage(messageId: string): boolean {
  for (const [inbox, messages] of inboxes) {
    const index = messages.findIndex(m => m.id === messageId);
    if (index !== -1) {
      messages.splice(index, 1);
      persistStore();
      console.log(`🗑️ Message ${messageId} deleted`);
      return true;
    }
  }
  return false;
}

// Get all inboxes (for UI)
export function getAllInboxes(): string[] {
  return Array.from(inboxes.keys());
}

// Get stats
export function getStats(): { inboxes: number; messages: number; pending: number; approved: number; inProgress: number } {
  let inboxCount = 0;
  let messages = 0;
  let pending = 0;
  let approved = 0;
  let inProgress = 0;
  
  for (const [_, msgs] of inboxes) {
    if (msgs.length > 0) {
      inboxCount++;
      messages += msgs.length;
      pending += msgs.filter(m => m.status === 'pending').length;
      approved += msgs.filter(m => m.status === 'approved').length;
      inProgress += msgs.filter(m => m.status === 'in_progress').length;
    }
  }
  
  return {
    inboxes: inboxCount,
    messages,
    pending,
    approved,
    inProgress,
  };
}

// Reset all data (admin function)
export function resetAllData(): { cleared: number } {
  const totalMessages = Array.from(inboxes.values()).reduce((sum, msgs) => sum + msgs.length, 0);
  inboxes.clear();
  persistStore();
  console.log(`🔄 All data reset - cleared ${totalMessages} messages`);
  return { cleared: totalMessages };
}

// Get all messages in a thread
export function getThreadMessages(threadId: string): QuackMessage[] {
  const threadMessages: QuackMessage[] = [];
  
  for (const [_, messages] of inboxes) {
    for (const msg of messages) {
      // Include messages that are part of this thread OR are the thread starter
      if (msg.threadId === threadId || msg.id === threadId) {
        threadMessages.push(msg);
      }
    }
  }
  
  // Sort by timestamp
  threadMessages.sort((a, b) => 
    new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );
  
  return threadMessages;
}

// Get all threads (grouped by threadId)
export function getAllThreads(): { threadId: string; messages: QuackMessage[]; latestTimestamp: string }[] {
  const threads = new Map<string, QuackMessage[]>();
  
  for (const [_, messages] of inboxes) {
    for (const msg of messages) {
      const tid = msg.threadId || msg.id;
      if (!threads.has(tid)) {
        threads.set(tid, []);
      }
      threads.get(tid)!.push(msg);
    }
  }
  
  // Convert to array and sort each thread's messages
  const result = Array.from(threads.entries()).map(([threadId, messages]) => {
    messages.sort((a, b) => 
      new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );
    return {
      threadId,
      messages,
      latestTimestamp: messages[messages.length - 1].timestamp,
    };
  });
  
  // Sort threads by latest message
  result.sort((a, b) => 
    new Date(b.latestTimestamp).getTime() - new Date(a.latestTimestamp).getTime()
  );
  
  return result;
}
