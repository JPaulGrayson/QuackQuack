import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { QuackMessage } from './types.js';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

export interface ArchivedThread {
  id: string;
  threadId: string;
  participants: string[];
  messageCount: number;
  firstMessageAt: Date;
  lastMessageAt: Date;
  archivedAt: Date;
  messages: QuackMessage[];
  metadata: Record<string, unknown>;
}

export interface AuditLogEntry {
  id: number;
  timestamp: Date;
  action: string;
  actor: string;
  targetType: string;
  targetId: string;
  details: Record<string, unknown>;
  ipAddress?: string;
}

export type AuditAction = 
  | 'message.send'
  | 'message.approve'
  | 'message.reject'
  | 'message.complete'
  | 'message.status_change'
  | 'message.read'
  | 'thread.archive'
  | 'agent.register'
  | 'agent.update'
  | 'agent.delete'
  | 'webhook.register'
  | 'webhook.delete'
  | 'file.upload'
  | 'file.delete';

export async function archiveThread(
  threadId: string,
  messages: QuackMessage[],
  metadata: Record<string, unknown> = {}
): Promise<string> {
  const id = randomUUID();
  const participants = [...new Set(messages.flatMap(m => [m.from, m.to]))];
  const timestamps = messages.map(m => new Date(m.timestamp));
  const firstMessageAt = new Date(Math.min(...timestamps.map(d => d.getTime())));
  const lastMessageAt = new Date(Math.max(...timestamps.map(d => d.getTime())));

  await pool.query(
    `INSERT INTO archived_threads 
     (id, thread_id, participants, message_count, first_message_at, last_message_at, messages, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [id, threadId, participants, messages.length, firstMessageAt, lastMessageAt, JSON.stringify(messages), JSON.stringify(metadata)]
  );

  return id;
}

export async function getArchivedThread(threadId: string): Promise<ArchivedThread | null> {
  const result = await pool.query(
    'SELECT * FROM archived_threads WHERE thread_id = $1 ORDER BY archived_at DESC LIMIT 1',
    [threadId]
  );
  
  if (result.rows.length === 0) return null;
  
  const row = result.rows[0];
  return {
    id: row.id,
    threadId: row.thread_id,
    participants: row.participants,
    messageCount: row.message_count,
    firstMessageAt: row.first_message_at,
    lastMessageAt: row.last_message_at,
    archivedAt: row.archived_at,
    messages: row.messages,
    metadata: row.metadata
  };
}

export async function listArchivedThreads(options: {
  limit?: number;
  offset?: number;
  participant?: string;
  since?: Date;
  until?: Date;
} = {}): Promise<{ threads: ArchivedThread[]; total: number }> {
  const { limit = 50, offset = 0, participant, since, until } = options;
  
  let whereClause = '';
  const params: unknown[] = [];
  const conditions: string[] = [];
  
  if (participant) {
    params.push(participant);
    conditions.push(`$${params.length} = ANY(participants)`);
  }
  
  if (since) {
    params.push(since);
    conditions.push(`archived_at >= $${params.length}`);
  }
  
  if (until) {
    params.push(until);
    conditions.push(`archived_at <= $${params.length}`);
  }
  
  if (conditions.length > 0) {
    whereClause = 'WHERE ' + conditions.join(' AND ');
  }
  
  const countResult = await pool.query(
    `SELECT COUNT(*) FROM archived_threads ${whereClause}`,
    params
  );
  
  params.push(limit, offset);
  const result = await pool.query(
    `SELECT * FROM archived_threads ${whereClause} 
     ORDER BY archived_at DESC 
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  
  return {
    threads: result.rows.map(row => ({
      id: row.id,
      threadId: row.thread_id,
      participants: row.participants,
      messageCount: row.message_count,
      firstMessageAt: row.first_message_at,
      lastMessageAt: row.last_message_at,
      archivedAt: row.archived_at,
      messages: row.messages,
      metadata: row.metadata
    })),
    total: parseInt(countResult.rows[0].count)
  };
}

export async function logAudit(
  action: AuditAction,
  actor: string,
  targetType: string,
  targetId: string,
  details: Record<string, unknown> = {},
  ipAddress?: string
): Promise<void> {
  await pool.query(
    `INSERT INTO audit_log (action, actor, target_type, target_id, details, ip_address)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [action, actor, targetType, targetId, JSON.stringify(details), ipAddress]
  );
}

export async function getAuditLogs(options: {
  limit?: number;
  offset?: number;
  action?: string;
  actor?: string;
  targetType?: string;
  targetId?: string;
  since?: Date;
  until?: Date;
} = {}): Promise<{ logs: AuditLogEntry[]; total: number }> {
  const { limit = 100, offset = 0, action, actor, targetType, targetId, since, until } = options;
  
  const conditions: string[] = [];
  const params: unknown[] = [];
  
  if (action) {
    params.push(action);
    conditions.push(`action = $${params.length}`);
  }
  
  if (actor) {
    params.push(actor);
    conditions.push(`actor = $${params.length}`);
  }
  
  if (targetType) {
    params.push(targetType);
    conditions.push(`target_type = $${params.length}`);
  }
  
  if (targetId) {
    params.push(targetId);
    conditions.push(`target_id = $${params.length}`);
  }
  
  if (since) {
    params.push(since);
    conditions.push(`timestamp >= $${params.length}`);
  }
  
  if (until) {
    params.push(until);
    conditions.push(`timestamp <= $${params.length}`);
  }
  
  const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
  
  const countResult = await pool.query(
    `SELECT COUNT(*) FROM audit_log ${whereClause}`,
    params
  );
  
  params.push(limit, offset);
  const result = await pool.query(
    `SELECT * FROM audit_log ${whereClause} 
     ORDER BY timestamp DESC 
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  
  return {
    logs: result.rows.map(row => ({
      id: row.id,
      timestamp: row.timestamp,
      action: row.action,
      actor: row.actor,
      targetType: row.target_type,
      targetId: row.target_id,
      details: row.details,
      ipAddress: row.ip_address
    })),
    total: parseInt(countResult.rows[0].count)
  };
}

export async function getAuditStats(): Promise<{
  totalEvents: number;
  last24Hours: number;
  topActions: { action: string; count: number }[];
  topActors: { actor: string; count: number }[];
}> {
  const [totalResult, last24hResult, actionsResult, actorsResult] = await Promise.all([
    pool.query('SELECT COUNT(*) FROM audit_log'),
    pool.query("SELECT COUNT(*) FROM audit_log WHERE timestamp > NOW() - INTERVAL '24 hours'"),
    pool.query(`
      SELECT action, COUNT(*) as count 
      FROM audit_log 
      GROUP BY action 
      ORDER BY count DESC 
      LIMIT 10
    `),
    pool.query(`
      SELECT actor, COUNT(*) as count 
      FROM audit_log 
      GROUP BY actor 
      ORDER BY count DESC 
      LIMIT 10
    `)
  ]);

  return {
    totalEvents: parseInt(totalResult.rows[0].count),
    last24Hours: parseInt(last24hResult.rows[0].count),
    topActions: actionsResult.rows.map(r => ({ action: r.action, count: parseInt(r.count) })),
    topActors: actorsResult.rows.map(r => ({ actor: r.actor, count: parseInt(r.count) }))
  };
}

export async function testConnection(): Promise<boolean> {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch (e) {
    console.error('Database connection failed:', e);
    return false;
  }
}

export { pool };
