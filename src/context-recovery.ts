import { Pool } from 'pg';

export type AuditLogType = 'MESSAGE' | 'THOUGHT' | 'ERROR' | 'CHECKPOINT';

export interface ContextSnapshot {
  current_task?: string;
  last_file_edited?: string;
  blocking_issue?: string;
  [key: string]: any;
}

export interface AuditLog {
  id?: number;
  session_id: string;
  timestamp: string;
  agent_id: string;
  type: AuditLogType;
  content: string;
  context_snapshot?: ContextSnapshot;
}

export interface JournalRequest {
  session_id: string;
  agent_id: string;
  type: AuditLogType;
  content: string;
  context_snapshot?: ContextSnapshot;
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

export async function initContextRecoveryTables(): Promise<void> {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS agent_journal (
        id SERIAL PRIMARY KEY,
        session_id VARCHAR(255) NOT NULL,
        timestamp TIMESTAMPTZ DEFAULT NOW(),
        agent_id VARCHAR(255) NOT NULL,
        type VARCHAR(50) NOT NULL,
        content TEXT NOT NULL,
        context_snapshot JSONB,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      
      CREATE INDEX IF NOT EXISTS idx_journal_session ON agent_journal(session_id);
      CREATE INDEX IF NOT EXISTS idx_journal_agent ON agent_journal(agent_id);
      CREATE INDEX IF NOT EXISTS idx_journal_timestamp ON agent_journal(timestamp DESC);
    `);
    console.log('🧠 Context Recovery tables initialized');
  } catch (error) {
    console.error('Failed to init context recovery tables:', error);
  }
}

export async function saveJournalEntry(entry: JournalRequest): Promise<AuditLog> {
  const timestamp = new Date().toISOString();
  const result = await pool.query(
    `INSERT INTO agent_journal (session_id, timestamp, agent_id, type, content, context_snapshot)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [
      entry.session_id,
      timestamp,
      entry.agent_id,
      entry.type,
      entry.content,
      entry.context_snapshot ? JSON.stringify(entry.context_snapshot) : null
    ]
  );
  
  return {
    id: result.rows[0].id,
    session_id: result.rows[0].session_id,
    timestamp: result.rows[0].timestamp,
    agent_id: result.rows[0].agent_id,
    type: result.rows[0].type,
    content: result.rows[0].content,
    context_snapshot: result.rows[0].context_snapshot
  };
}

export async function getSessionLogs(sessionId: string, limit: number = 50): Promise<AuditLog[]> {
  const result = await pool.query(
    `SELECT * FROM agent_journal 
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
    context_snapshot: row.context_snapshot
  }));
}

export async function getAgentSessions(agentId: string): Promise<string[]> {
  const result = await pool.query(
    `SELECT DISTINCT session_id FROM agent_journal 
     WHERE agent_id = $1 
     ORDER BY session_id`,
    [agentId]
  );
  
  return result.rows.map(row => row.session_id);
}

export async function getLatestSession(agentId: string): Promise<string | null> {
  const result = await pool.query(
    `SELECT session_id FROM agent_journal 
     WHERE agent_id = $1 
     ORDER BY timestamp DESC 
     LIMIT 1`,
    [agentId]
  );
  
  return result.rows[0]?.session_id || null;
}

export function generateContextPrompt(logs: AuditLog[]): string {
  if (logs.length === 0) {
    return 'No previous session data found. Starting fresh.';
  }
  
  const reversedLogs = [...logs].reverse();
  const lastCheckpoint = reversedLogs.find(l => l.type === 'CHECKPOINT');
  const lastError = reversedLogs.find(l => l.type === 'ERROR');
  const lastThought = reversedLogs.find(l => l.type === 'THOUGHT');
  
  let summary = '';
  
  if (lastCheckpoint?.context_snapshot) {
    const snap = lastCheckpoint.context_snapshot;
    summary += `LAST KNOWN STATE:\n`;
    if (snap.current_task) summary += `- Current Task: ${snap.current_task}\n`;
    if (snap.last_file_edited) summary += `- Last File Edited: ${snap.last_file_edited}\n`;
    if (snap.blocking_issue) summary += `- Blocking Issue: ${snap.blocking_issue}\n`;
  }
  
  summary += `\nRECENT LOGS:\n`;
  const recentLogs = reversedLogs.slice(-10);
  for (const log of recentLogs) {
    const time = new Date(log.timestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    summary += `- [${time}] ${log.type}: ${log.content.substring(0, 200)}${log.content.length > 200 ? '...' : ''}\n`;
  }
  
  if (lastError) {
    summary += `\nIMMEDIATE GOAL: Address the error: ${lastError.content.substring(0, 100)}\n`;
  } else if (lastThought) {
    summary += `\nIMMEDIATE GOAL: Continue from last thought: ${lastThought.content.substring(0, 100)}\n`;
  }
  
  return `SYSTEM INJECTION:
You are resuming an active session.

${summary}`;
}

export function generateUniversalScript(agentId: string, contextPrompt?: string): string {
  const dynamicSection = contextPrompt 
    ? `\n[DYNAMIC SECTION - INJECTED BY SERVER]\n**RESUMPTION CONTEXT:**\n${contextPrompt}\n*****************************************\nPlease acknowledge you have received this context and explicitly state your next step based on the "Immediate Goal" above.`
    : '\n[No previous session context found. Starting fresh.]';

  return `[SYSTEM INSTRUCTION - DO NOT IGNORE]
You are connected to the Quack Session Manager.
Agent ID: ${agentId}

YOUR CORE PROTOCOLS:
1. **Heartbeat:** Every 5 messages or after a significant code change, you MUST emit a status update to Quack using the journal endpoint.
2. **Context preservation:** If you hit a complex problem, log your reasoning *before* attempting the fix. This creates a save point.
3. **Messaging:** You have tools to message other agents via Quack. If you are working alone, focus on journaling your progress.

QUACK ENDPOINTS:
- POST /api/v1/agent/journal - Log your thoughts, errors, and checkpoints
- GET /api/v1/agent/context/{session_id} - Retrieve session context

${dynamicSection}`;
}
