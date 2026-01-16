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

// Clean up expired messages
function cleanupExpired(): void {
  const now = new Date();
  let cleaned = 0;
  
  for (const [inbox, messages] of inboxes) {
    const valid = messages.filter(m => {
      const expires = new Date(m.expiresAt);
      return expires > now;
    });
    
    cleaned += messages.length - valid.length;
    inboxes.set(inbox, valid);
  }
  
  if (cleaned > 0) {
    console.log(`🧹 Cleaned ${cleaned} expired messages`);
    persistStore();
  }
}

// Send a message
export function sendMessage(req: SendMessageRequest, fromAgent: string): QuackMessage {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + TTL_HOURS * 60 * 60 * 1000);
  
  const message: QuackMessage = {
    id: uuid(),
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
  
  console.log(`📨 Message ${message.id} sent to /${inbox}`);
  return message;
}

// Check inbox for messages
export function checkInbox(inbox: string, includeRead: boolean = false): QuackMessage[] {
  const messages = inboxes.get(inbox.toLowerCase()) || [];
  
  if (includeRead) {
    return messages;
  }
  
  return messages.filter(m => m.status === 'pending');
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

// Get all inboxes (for UI)
export function getAllInboxes(): string[] {
  return Array.from(inboxes.keys());
}

// Get stats
export function getStats(): { inboxes: number; messages: number; pending: number } {
  let messages = 0;
  let pending = 0;
  
  for (const [_, msgs] of inboxes) {
    messages += msgs.length;
    pending += msgs.filter(m => m.status === 'pending').length;
  }
  
  return {
    inboxes: inboxes.size,
    messages,
    pending,
  };
}
