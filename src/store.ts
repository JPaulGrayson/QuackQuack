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
  MessageStatus 
} from './types.js';

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
function cleanupExpired(): void {
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

// Validate inbox path format (must be platform/application, not just a single name)
// Top-level identities like "orchestrate" should be "replit/orchestrate" or "claude/orchestrate"
export function validateInboxPath(to: string): { valid: boolean; error?: string } {
  const parts = to.split('/').filter(p => p.length > 0);
  
  if (parts.length < 2) {
    return { 
      valid: false, 
      error: `Invalid inbox path "${to}". Messages must be sent to platform/application format (e.g., "replit/orchestrate", "claude/project-alpha"). Got single identifier "${to}" instead.`
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
  
  const message: QuackMessage = {
    id: messageId,
    to: req.to,
    from: fromAgent || req.from,
    timestamp: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    status: 'pending',
    task: req.task,
    context: req.context,
    files: req.files || [],
    projectName: req.projectName,
    conversationExcerpt: req.conversationExcerpt,
    replyTo: req.replyTo,
    threadId: threadId || messageId,  // Root messages get their own ID as threadId
  };
  
  // Add file sizes if not present
  message.files = message.files.map(f => ({
    ...f,
    size: f.size || Buffer.byteLength(f.content, 'utf-8'),
  }));
  
  // Get or create inbox
  const inbox = req.to.toLowerCase();
  if (!inboxes.has(inbox)) {
    inboxes.set(inbox, []);
  }
  
  inboxes.get(inbox)!.push(message);
  persistStore();
  
  console.log(`📨 Message ${message.id} sent to /${inbox}${threadId ? ` (thread: ${threadId.substring(0, 8)}...)` : ''}`);
  return message;
}

// Check inbox for messages
// By default returns actionable messages (pending, approved, in_progress)
// Use includeRead=true to also see read/completed/failed messages
export function checkInbox(inbox: string, includeRead: boolean = false): QuackMessage[] {
  const messages = inboxes.get(inbox.toLowerCase()) || [];
  
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
      message.status = status;
      persistStore();
      console.log(`📝 Message ${messageId} status updated to: ${status}`);
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
export function getStats(): { inboxes: number; messages: number; pending: number } {
  let inboxCount = 0;
  let messages = 0;
  let pending = 0;
  
  for (const [_, msgs] of inboxes) {
    if (msgs.length > 0) {
      inboxCount++;
      messages += msgs.length;
      pending += msgs.filter(m => m.status === 'pending').length;
    }
  }
  
  return {
    inboxes: inboxCount,
    messages,
    pending,
  };
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
