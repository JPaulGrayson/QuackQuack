/**
 * Session Registry (OpenClaw-inspired)
 * Tracks active agent-to-agent conversation sessions with state
 * 
 * This is different from cowork-store (agent configs) and store (messages).
 * Sessions track the STATE of multi-message conversations between agents.
 * 
 * Key concepts from OpenClaw:
 * - Session keys: structured naming like "agent:<agentId>:<channel>:<type>:<id>"
 * - Session state: active, awaiting_reply, awaiting_human, completed, abandoned
 * - Participant tracking: who's in the conversation
 * - Turn tracking: whose turn is it to respond
 */

import fs from 'fs';
import path from 'path';
import { v4 as uuid } from 'uuid';
import { ThreadStatus, ControlMessageType } from './types.js';

// Session key format: "agent:<from>:to:<to>:thread:<threadId>"
// Example: "agent:claude/web:to:replit/quack:thread:abc123"

export interface Session {
  // Identity
  sessionId: string;              // UUID
  sessionKey: string;             // Structured key for lookup
  threadId: string;               // Links to message thread
  
  // Participants
  initiator: string;              // Who started the session (from)
  responder: string;              // Who is being talked to (to)
  participants: string[];         // All agents that have participated
  
  // State
  status: SessionStatus;
  currentTurn?: string;           // Agent expected to respond next
  turnCount: number;              // Number of back-and-forth exchanges
  
  // Timing
  createdAt: string;              // ISO 8601
  updatedAt: string;              // ISO 8601
  lastMessageAt?: string;         // When last message was sent
  completedAt?: string;           // When session ended
  expiresAt: string;              // Auto-expire inactive sessions
  
  // Completion
  completedBy?: string;           // Agent that ended the session
  completionReason?: CompletionReason;
  
  // Metadata
  messageCount: number;
  contextTokens?: number;         // Estimated context size
  model?: string;                 // Model being used (if known)
  tags?: string[];
}

export type SessionStatus = 
  | 'active'           // Conversation ongoing
  | 'awaiting_reply'   // Waiting for response from specific agent
  | 'awaiting_human'   // Paused, waiting for human input
  | 'completed'        // Conversation finished normally
  | 'abandoned';       // No activity, timed out

export type CompletionReason = 
  | ControlMessageType  // REPLY_SKIP, ANNOUNCE_SKIP, CONVERSATION_END
  | 'timeout'           // No activity for too long
  | 'manual'            // Manually ended
  | 'error';            // Error occurred

// Session list filters (like OpenClaw's sessions_list)
export interface SessionListOptions {
  kinds?: SessionStatus[];        // Filter by status
  participant?: string;           // Filter by participant
  limit?: number;                 // Max results (default 50)
  activeMinutes?: number;         // Only sessions active within N minutes
  includeCompleted?: boolean;     // Include completed sessions
}

// Storage
const SESSION_FILE = './data/sessions.json';
const SESSION_TTL_HOURS = 24;  // Sessions expire after 24 hours of inactivity

const sessions: Map<string, Session> = new Map();

// ============== Initialization ==============

export function initSessionRegistry(): void {
  try {
    const dir = path.dirname(SESSION_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    
    if (fs.existsSync(SESSION_FILE)) {
      const data = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8'));
      for (const [key, session] of Object.entries(data)) {
        sessions.set(key, session as Session);
      }
      console.log(`📋 Sessions: Loaded ${sessions.size} sessions`);
    }
  } catch (err) {
    console.error('Failed to load session registry:', err);
  }
  
  // Cleanup expired sessions every 15 minutes
  setInterval(cleanupExpiredSessions, 15 * 60 * 1000);
  cleanupExpiredSessions();
}

function persistSessions(): void {
  try {
    const data: Record<string, Session> = {};
    for (const [key, session] of sessions) {
      data[key] = session;
    }
    fs.writeFileSync(SESSION_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('Failed to persist sessions:', err);
  }
}

// ============== Session Key Generation ==============

export function generateSessionKey(from: string, to: string, threadId: string): string {
  // Normalize: remove leading slashes, lowercase
  const fromNorm = from.replace(/^\/+/, '').toLowerCase();
  const toNorm = to.replace(/^\/+/, '').toLowerCase();
  return `agent:${fromNorm}:to:${toNorm}:thread:${threadId}`;
}

export function parseSessionKey(key: string): { from: string; to: string; threadId: string } | null {
  const match = key.match(/^agent:(.+):to:(.+):thread:(.+)$/);
  if (!match) return null;
  return { from: match[1], to: match[2], threadId: match[3] };
}

// ============== Session CRUD ==============

export function createSession(
  from: string, 
  to: string, 
  threadId: string,
  options?: { tags?: string[]; model?: string }
): Session {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_HOURS * 60 * 60 * 1000);
  
  const sessionKey = generateSessionKey(from, to, threadId);
  
  // Check if session already exists
  const existing = sessions.get(sessionKey);
  if (existing) {
    // Update existing session
    existing.updatedAt = now.toISOString();
    existing.lastMessageAt = now.toISOString();
    existing.expiresAt = expiresAt.toISOString();
    existing.messageCount++;
    
    // Add participant if new
    const fromNorm = from.replace(/^\/+/, '').toLowerCase();
    if (!existing.participants.includes(fromNorm)) {
      existing.participants.push(fromNorm);
    }
    
    persistSessions();
    return existing;
  }
  
  // Create new session
  const session: Session = {
    sessionId: uuid(),
    sessionKey,
    threadId,
    initiator: from.replace(/^\/+/, '').toLowerCase(),
    responder: to.replace(/^\/+/, '').toLowerCase(),
    participants: [
      from.replace(/^\/+/, '').toLowerCase(),
      to.replace(/^\/+/, '').toLowerCase()
    ],
    status: 'active',
    currentTurn: to.replace(/^\/+/, '').toLowerCase(),  // Responder's turn first
    turnCount: 0,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    lastMessageAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    messageCount: 1,
    tags: options?.tags,
    model: options?.model,
  };
  
  sessions.set(sessionKey, session);
  persistSessions();
  
  console.log(`📋 Session created: ${sessionKey}`);
  return session;
}

export function getSession(sessionKey: string): Session | null {
  return sessions.get(sessionKey) || null;
}

export function getSessionByThreadId(threadId: string): Session | null {
  for (const session of sessions.values()) {
    if (session.threadId === threadId) {
      return session;
    }
  }
  return null;
}

export function getSessionById(sessionId: string): Session | null {
  for (const session of sessions.values()) {
    if (session.sessionId === sessionId) {
      return session;
    }
  }
  return null;
}

// ============== Session State Updates ==============

export function updateSessionStatus(
  sessionKey: string, 
  status: SessionStatus,
  options?: { 
    completedBy?: string; 
    completionReason?: CompletionReason;
    currentTurn?: string;
  }
): Session | null {
  const session = sessions.get(sessionKey);
  if (!session) return null;
  
  const now = new Date().toISOString();
  session.status = status;
  session.updatedAt = now;
  
  if (options?.currentTurn) {
    session.currentTurn = options.currentTurn;
  }
  
  if (status === 'completed' || status === 'abandoned') {
    session.completedAt = now;
    session.completedBy = options?.completedBy;
    session.completionReason = options?.completionReason;
  }
  
  persistSessions();
  console.log(`📋 Session ${sessionKey} status: ${status}`);
  return session;
}

export function recordSessionMessage(
  sessionKey: string,
  from: string,
  isControlMessage: boolean = false,
  controlType?: ControlMessageType
): Session | null {
  const session = sessions.get(sessionKey);
  if (!session) return null;
  
  const now = new Date();
  const fromNorm = from.replace(/^\/+/, '').toLowerCase();
  
  session.updatedAt = now.toISOString();
  session.lastMessageAt = now.toISOString();
  session.expiresAt = new Date(now.getTime() + SESSION_TTL_HOURS * 60 * 60 * 1000).toISOString();
  session.messageCount++;
  
  // Update turn - switch to the other participant
  if (session.currentTurn === fromNorm) {
    session.turnCount++;
    // Find next participant (simple toggle for 2-party conversations)
    const otherParticipants = session.participants.filter(p => p !== fromNorm);
    session.currentTurn = otherParticipants[0] || fromNorm;
  }
  
  // Add participant if new
  if (!session.participants.includes(fromNorm)) {
    session.participants.push(fromNorm);
  }
  
  // Handle control messages
  if (isControlMessage && controlType) {
    if (controlType === 'CONVERSATION_END') {
      session.status = 'completed';
      session.completedAt = now.toISOString();
      session.completedBy = fromNorm;
      session.completionReason = controlType;
    } else if (controlType === 'REPLY_SKIP') {
      // Sender is done, waiting on the other party or ending
      session.status = 'awaiting_reply';
    } else if (controlType === 'ANNOUNCE_SKIP') {
      // Don't change session state, just skip announcement
    }
  }
  
  persistSessions();
  return session;
}

// ============== Session Queries (like OpenClaw's sessions_list) ==============

export function listSessions(options?: SessionListOptions): Session[] {
  const limit = options?.limit || 50;
  const now = new Date();
  
  let results = Array.from(sessions.values());
  
  // Filter by status
  if (options?.kinds && options.kinds.length > 0) {
    results = results.filter(s => options.kinds!.includes(s.status));
  }
  
  // Filter by participant
  if (options?.participant) {
    const participant = options.participant.replace(/^\/+/, '').toLowerCase();
    results = results.filter(s => s.participants.includes(participant));
  }
  
  // Filter by activity time
  if (options?.activeMinutes) {
    const cutoff = new Date(now.getTime() - options.activeMinutes * 60 * 1000);
    results = results.filter(s => new Date(s.updatedAt) > cutoff);
  }
  
  // Exclude completed unless requested
  if (!options?.includeCompleted) {
    results = results.filter(s => s.status !== 'completed' && s.status !== 'abandoned');
  }
  
  // Sort by last update (most recent first)
  results.sort((a, b) => 
    new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  );
  
  return results.slice(0, limit);
}

export function getSessionsForAgent(agent: string): Session[] {
  const agentNorm = agent.replace(/^\/+/, '').toLowerCase();
  return Array.from(sessions.values())
    .filter(s => s.participants.includes(agentNorm))
    .sort((a, b) => 
      new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    );
}

export function getActiveSessionCount(): number {
  return Array.from(sessions.values())
    .filter(s => s.status === 'active' || s.status === 'awaiting_reply')
    .length;
}

// ============== Session Stats ==============

export function getSessionStats(): {
  total: number;
  active: number;
  awaitingReply: number;
  awaitingHuman: number;
  completed: number;
  abandoned: number;
  avgTurnCount: number;
  avgMessageCount: number;
} {
  const all = Array.from(sessions.values());
  const active = all.filter(s => s.status === 'active');
  const completed = all.filter(s => s.status === 'completed');
  
  const totalTurns = all.reduce((sum, s) => sum + s.turnCount, 0);
  const totalMessages = all.reduce((sum, s) => sum + s.messageCount, 0);
  
  return {
    total: all.length,
    active: active.length,
    awaitingReply: all.filter(s => s.status === 'awaiting_reply').length,
    awaitingHuman: all.filter(s => s.status === 'awaiting_human').length,
    completed: completed.length,
    abandoned: all.filter(s => s.status === 'abandoned').length,
    avgTurnCount: all.length > 0 ? totalTurns / all.length : 0,
    avgMessageCount: all.length > 0 ? totalMessages / all.length : 0,
  };
}

// ============== Cleanup ==============

function cleanupExpiredSessions(): void {
  const now = new Date();
  let cleaned = 0;
  
  for (const [key, session] of sessions) {
    const expires = new Date(session.expiresAt);
    
    // Mark as abandoned if expired and still active
    if (expires <= now && (session.status === 'active' || session.status === 'awaiting_reply')) {
      session.status = 'abandoned';
      session.completedAt = now.toISOString();
      session.completionReason = 'timeout';
      cleaned++;
    }
    
    // Remove very old completed/abandoned sessions (older than 7 days)
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    if (
      (session.status === 'completed' || session.status === 'abandoned') &&
      new Date(session.updatedAt) < sevenDaysAgo
    ) {
      sessions.delete(key);
      cleaned++;
    }
  }
  
  if (cleaned > 0) {
    console.log(`📋 Sessions: Cleaned up ${cleaned} expired/old sessions`);
    persistSessions();
  }
}

export function endSession(
  sessionKey: string, 
  by: string, 
  reason: CompletionReason = 'manual'
): Session | null {
  return updateSessionStatus(sessionKey, 'completed', {
    completedBy: by,
    completionReason: reason,
  });
}

// ============== Export for server.ts ==============

export {
  sessions,  // For debugging
};
