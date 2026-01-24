import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';

export type AuditLogType = 'MESSAGE' | 'THOUGHT' | 'ERROR' | 'CHECKPOINT';

export interface ContextSnapshot {
  current_task?: string;
  last_file_edited?: string;
  blocking_issue?: string;
  working_directory?: string;
  recent_decisions?: string[];
  custom_state?: Record<string, any>;
}

export interface AuditLogCreate {
  agent_id: string;
  type: AuditLogType;
  content: any;
  session_id?: string;
  context_snapshot?: ContextSnapshot;
  target_agent?: string;
  tags?: string[];
}

export interface AuditLogEntry {
  id: string;
  session_id: string;
  timestamp: string;
  agent_id: string;
  type: AuditLogType;
  content: any;
  context_snapshot?: ContextSnapshot;
  target_agent?: string;
  tags?: string[];
}

export interface ContextSummary {
  summary_text: string;
  immediate_goal: string;
  key_decisions: string[];
  unresolved_issues: string[];
}

export interface ContextResponse {
  session_id: string;
  agent_id: string;
  entry_count: number;
  summary: ContextSummary | null;
  recent_logs: AuditLogEntry[];
  injection_prompt: string;
}

export const contextPool = new Pool({
  connectionString: process.env.DATABASE_URL
});
const pool = contextPool;

export async function initContextRecoveryTables(): Promise<void> {
  try {
    // Create tables first
    await pool.query(`
      CREATE TABLE IF NOT EXISTS context_sessions (
        session_id VARCHAR(255) PRIMARY KEY,
        agent_id VARCHAR(255) NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        last_activity TIMESTAMPTZ DEFAULT NOW(),
        entry_count INTEGER DEFAULT 0
      );
      
      CREATE TABLE IF NOT EXISTS context_audit_logs (
        id VARCHAR(255) PRIMARY KEY,
        session_id VARCHAR(255) REFERENCES context_sessions(session_id) ON DELETE CASCADE,
        timestamp TIMESTAMPTZ DEFAULT NOW(),
        agent_id VARCHAR(255) NOT NULL,
        type VARCHAR(50) NOT NULL,
        content JSONB,
        context_snapshot JSONB,
        target_agent VARCHAR(255),
        tags JSONB
      );
    `);
    
    // Add is_active column if it doesn't exist (for existing tables)
    await pool.query(`
      ALTER TABLE context_sessions ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true;
    `);
    
    // Create indexes after column exists
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_ctx_logs_session ON context_audit_logs(session_id);
      CREATE INDEX IF NOT EXISTS idx_ctx_logs_agent ON context_audit_logs(agent_id);
      CREATE INDEX IF NOT EXISTS idx_ctx_logs_timestamp ON context_audit_logs(timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_ctx_sessions_agent ON context_sessions(agent_id);
      CREATE INDEX IF NOT EXISTS idx_ctx_sessions_active ON context_sessions(agent_id, is_active);
    `);
    
    console.log('🧠 Context Recovery tables initialized');
  } catch (error) {
    console.error('Failed to init context recovery tables:', error);
  }
}

export async function getOrCreateSession(agentId: string, sessionId?: string): Promise<string> {
  // If explicit session_id provided, use it
  if (sessionId) {
    const existing = await pool.query(
      'SELECT session_id FROM context_sessions WHERE session_id = $1',
      [sessionId]
    );
    
    if (existing.rows.length > 0) {
      return sessionId;
    }
    
    // Create new session with provided ID
    await pool.query(
      `INSERT INTO context_sessions (session_id, agent_id, created_at, last_activity, entry_count, is_active)
       VALUES ($1, $2, NOW(), NOW(), 0, true)
       ON CONFLICT (session_id) DO NOTHING`,
      [sessionId, agentId]
    );
    return sessionId;
  }
  
  // Look for existing ACTIVE session for this agent (active within last 24 hours)
  const activeSession = await pool.query(
    `SELECT session_id FROM context_sessions 
     WHERE agent_id = $1 
       AND is_active = true 
       AND last_activity > NOW() - INTERVAL '24 hours'
     ORDER BY last_activity DESC 
     LIMIT 1`,
    [agentId]
  );
  
  if (activeSession.rows.length > 0) {
    return activeSession.rows[0].session_id;
  }
  
  // No active session - create new one
  const newId = uuidv4();
  await pool.query(
    `INSERT INTO context_sessions (session_id, agent_id, created_at, last_activity, entry_count, is_active)
     VALUES ($1, $2, NOW(), NOW(), 0, true)`,
    [newId, agentId]
  );
  
  return newId;
}

export async function saveJournalEntry(entry: AuditLogCreate): Promise<AuditLogEntry> {
  const sessionId = await getOrCreateSession(entry.agent_id, entry.session_id);
  const id = uuidv4();
  const timestamp = new Date().toISOString();
  
  await pool.query(
    `INSERT INTO context_audit_logs (id, session_id, timestamp, agent_id, type, content, context_snapshot, target_agent, tags)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      id,
      sessionId,
      timestamp,
      entry.agent_id,
      entry.type,
      JSON.stringify(entry.content),
      entry.context_snapshot ? JSON.stringify(entry.context_snapshot) : null,
      entry.target_agent || null,
      entry.tags ? JSON.stringify(entry.tags) : null
    ]
  );
  
  await pool.query(
    `UPDATE context_sessions SET last_activity = NOW(), entry_count = entry_count + 1 WHERE session_id = $1`,
    [sessionId]
  );
  
  return {
    id,
    session_id: sessionId,
    timestamp,
    agent_id: entry.agent_id,
    type: entry.type,
    content: entry.content,
    context_snapshot: entry.context_snapshot,
    target_agent: entry.target_agent,
    tags: entry.tags
  };
}

export async function getSessionLogs(sessionId: string, limit: number = 50): Promise<AuditLogEntry[]> {
  const result = await pool.query(
    `SELECT * FROM context_audit_logs 
     WHERE session_id = $1 
     ORDER BY timestamp DESC 
     LIMIT $2`,
    [sessionId, limit]
  );
  
  return result.rows.map(row => ({
    id: row.id,
    session_id: row.session_id,
    timestamp: row.timestamp,
    agent_id: row.agent_id,
    type: row.type,
    content: row.content,
    context_snapshot: row.context_snapshot,
    target_agent: row.target_agent,
    tags: row.tags
  }));
}

export async function getLatestSessionForAgent(agentId: string): Promise<string | null> {
  const result = await pool.query(
    `SELECT session_id FROM context_sessions 
     WHERE agent_id = $1 
     ORDER BY last_activity DESC 
     LIMIT 1`,
    [agentId]
  );
  
  return result.rows[0]?.session_id || null;
}

export async function getSessionInfo(sessionId: string): Promise<{ agent_id: string; entry_count: number } | null> {
  const result = await pool.query(
    'SELECT agent_id, entry_count FROM context_sessions WHERE session_id = $1',
    [sessionId]
  );
  return result.rows[0] || null;
}

function generateMockSummary(entries: AuditLogEntry[], agentId: string): ContextSummary {
  const errors = entries.filter(e => e.type === 'ERROR');
  let latestSnapshot: ContextSnapshot | undefined;
  
  for (const entry of [...entries].reverse()) {
    if (entry.context_snapshot) {
      latestSnapshot = entry.context_snapshot;
      break;
    }
  }
  
  const summaryText = latestSnapshot?.current_task 
    ? `Working on: ${latestSnapshot.current_task}`
    : 'No context available';
    
  let immediateGoal = latestSnapshot?.blocking_issue || 'Continue work';
  if (errors.length > 0) {
    const lastError = errors[errors.length - 1];
    immediateGoal = `Fix error: ${String(lastError.content).substring(0, 80)}`;
  }
  
  return {
    summary_text: summaryText,
    immediate_goal: immediateGoal,
    key_decisions: latestSnapshot?.recent_decisions || [],
    unresolved_issues: errors.slice(-2).map(e => String(e.content).substring(0, 60))
  };
}

export function generateInjectionPrompt(summary: ContextSummary, recentLogs: AuditLogEntry[], agentId: string): string {
  let formattedLogs = '';
  const logsToShow = [...recentLogs].reverse().slice(-10);
  
  for (const entry of logsToShow) {
    const ts = new Date(entry.timestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    const content = String(entry.content).substring(0, 100);
    formattedLogs += `- [${ts}] ${entry.type}: ${content}\n`;
  }
  
  let prompt = `[SYSTEM INJECTION - DO NOT IGNORE]
You are connected to the Quack Session Manager. Agent ID: ${agentId}

CORE PROTOCOLS:
1. Heartbeat: Every 5 messages, POST status to /api/v1/agent/journal
2. Context preservation: Log reasoning BEFORE attempting risky fixes
3. Error logging: Log errors immediately to /api/v1/agent/error

*****************************************
RESUMPTION CONTEXT:
LAST KNOWN STATE: ${summary.summary_text}
IMMEDIATE GOAL: ${summary.immediate_goal}
`;

  if (summary.unresolved_issues.length > 0) {
    prompt += '\nUNRESOLVED ISSUES:\n';
    for (const issue of summary.unresolved_issues) {
      prompt += `  - ${issue}\n`;
    }
  }
  
  prompt += `
RECENT LOGS:
${formattedLogs}
*****************************************
Acknowledge this context and state your next step based on the Immediate Goal.
`;

  return prompt;
}

export async function getContextForSession(sessionId: string, limit: number = 50): Promise<ContextResponse> {
  const sessionInfo = await getSessionInfo(sessionId);
  if (!sessionInfo) {
    throw new Error('Session not found');
  }
  
  const entries = await getSessionLogs(sessionId, limit);
  const summary = generateMockSummary(entries, sessionInfo.agent_id);
  const injectionPrompt = generateInjectionPrompt(summary, entries, sessionInfo.agent_id);
  
  return {
    session_id: sessionId,
    agent_id: sessionInfo.agent_id,
    entry_count: entries.length,
    summary,
    recent_logs: entries,
    injection_prompt: injectionPrompt
  };
}

export async function getContextForAgent(agentId: string, limit: number = 50): Promise<ContextResponse> {
  const sessionId = await getLatestSessionForAgent(agentId);
  if (!sessionId) {
    throw new Error('No sessions found for agent');
  }
  return getContextForSession(sessionId, limit);
}

export function generateUniversalScript(agentId: string, context?: ContextResponse): string {
  let base = `[QUACK CONNECTED] Agent: ${agentId}

Protocols: Log thoughts to /api/v1/agent/thought, errors to /error, checkpoints to /checkpoint. Message others via /api/send.
`;

  if (context) {
    base += `
RESUMPTION: ${context.summary?.summary_text || 'No context'}
GOAL: ${context.summary?.immediate_goal || 'Continue work'}
`;
  } else {
    base += '\n[No prior context]\n';
  }
  
  return base;
}

export async function closeSession(sessionId: string): Promise<{ success: boolean; message: string }> {
  const result = await pool.query(
    `UPDATE context_sessions SET is_active = false, last_activity = NOW() WHERE session_id = $1 RETURNING session_id`,
    [sessionId]
  );
  
  if (result.rows.length === 0) {
    return { success: false, message: 'Session not found' };
  }
  
  return { success: true, message: `Session ${sessionId} closed` };
}

export async function closeAgentSessions(agentId: string): Promise<{ success: boolean; count: number }> {
  const result = await pool.query(
    `UPDATE context_sessions SET is_active = false, last_activity = NOW() WHERE agent_id = $1 AND is_active = true RETURNING session_id`,
    [agentId]
  );
  
  return { success: true, count: result.rows.length };
}

export async function startNewSession(agentId: string): Promise<string> {
  // Close any existing active sessions for this agent
  await closeAgentSessions(agentId);
  
  // Create new session
  const newId = uuidv4();
  await pool.query(
    `INSERT INTO context_sessions (session_id, agent_id, created_at, last_activity, entry_count, is_active)
     VALUES ($1, $2, NOW(), NOW(), 0, true)`,
    [newId, agentId]
  );
  
  return newId;
}
