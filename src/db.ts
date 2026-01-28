import { Pool } from 'pg';
import { randomUUID, createHash, createHmac, randomBytes } from 'crypto';
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

export interface Agent {
  id: string;
  name: string;
  platform: string;
  capabilities: string[];
  status: 'online' | 'offline' | 'unknown';
  public: boolean;
  owner: string;
  webhook?: string;
  webhookSecret?: string;
  created: Date;
  lastSeen: Date;
  metadata?: Record<string, unknown>;
}

export interface ApiKey {
  id: string;
  owner: string;
  name?: string;
  permissions: string[];
  createdAt: Date;
  lastUsed?: Date;
  revoked: boolean;
}

export async function createAgent(agent: Omit<Agent, 'created' | 'lastSeen'>): Promise<Agent> {
  const result = await pool.query(
    `INSERT INTO agents (id, name, platform, capabilities, status, public, owner, webhook, webhook_secret, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING *`,
    [agent.id, agent.name, agent.platform, agent.capabilities, agent.status || 'unknown', 
     agent.public !== false, agent.owner, agent.webhook, agent.webhookSecret, JSON.stringify(agent.metadata || {})]
  );
  return rowToAgent(result.rows[0]);
}

export async function getAgent(id: string): Promise<Agent | null> {
  const result = await pool.query('SELECT * FROM agents WHERE id = $1', [id]);
  if (result.rows.length === 0) return null;
  return rowToAgent(result.rows[0]);
}

export async function listAgents(options: { publicOnly?: boolean; owner?: string } = {}): Promise<Agent[]> {
  let query = 'SELECT * FROM agents';
  const params: unknown[] = [];
  const conditions: string[] = [];
  
  if (options.publicOnly) {
    conditions.push('public = true');
  }
  if (options.owner) {
    params.push(options.owner);
    conditions.push(`owner = $${params.length}`);
  }
  
  if (conditions.length > 0) {
    query += ' WHERE ' + conditions.join(' AND ');
  }
  query += ' ORDER BY last_seen DESC';
  
  const result = await pool.query(query, params);
  return result.rows.map(rowToAgent);
}

export async function updateAgent(id: string, updates: Partial<Omit<Agent, 'id' | 'created'>>): Promise<Agent | null> {
  const fields: string[] = [];
  const params: unknown[] = [];
  let paramIndex = 1;
  
  if (updates.name !== undefined) { fields.push(`name = $${paramIndex++}`); params.push(updates.name); }
  if (updates.platform !== undefined) { fields.push(`platform = $${paramIndex++}`); params.push(updates.platform); }
  if (updates.capabilities !== undefined) { fields.push(`capabilities = $${paramIndex++}`); params.push(updates.capabilities); }
  if (updates.status !== undefined) { fields.push(`status = $${paramIndex++}`); params.push(updates.status); }
  if (updates.public !== undefined) { fields.push(`public = $${paramIndex++}`); params.push(updates.public); }
  if (updates.owner !== undefined) { fields.push(`owner = $${paramIndex++}`); params.push(updates.owner); }
  if (updates.webhook !== undefined) { fields.push(`webhook = $${paramIndex++}`); params.push(updates.webhook); }
  if (updates.webhookSecret !== undefined) { fields.push(`webhook_secret = $${paramIndex++}`); params.push(updates.webhookSecret); }
  if (updates.lastSeen !== undefined) { fields.push(`last_seen = $${paramIndex++}`); params.push(updates.lastSeen); }
  if (updates.metadata !== undefined) { fields.push(`metadata = $${paramIndex++}`); params.push(JSON.stringify(updates.metadata)); }
  
  if (fields.length === 0) return getAgent(id);
  
  params.push(id);
  const result = await pool.query(
    `UPDATE agents SET ${fields.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
    params
  );
  
  if (result.rows.length === 0) return null;
  return rowToAgent(result.rows[0]);
}

export async function deleteAgent(id: string): Promise<boolean> {
  const result = await pool.query('DELETE FROM agents WHERE id = $1', [id]);
  return (result.rowCount || 0) > 0;
}

export async function pingAgent(id: string): Promise<Agent | null> {
  const result = await pool.query(
    'UPDATE agents SET last_seen = NOW(), status = $1 WHERE id = $2 RETURNING *',
    ['online', id]
  );
  if (result.rows.length === 0) return null;
  return rowToAgent(result.rows[0]);
}

function rowToAgent(row: any): Agent {
  return {
    id: row.id,
    name: row.name,
    platform: row.platform,
    capabilities: row.capabilities || [],
    status: row.status,
    public: row.public,
    owner: row.owner,
    webhook: row.webhook,
    webhookSecret: row.webhook_secret,
    created: row.created_at,
    lastSeen: row.last_seen,
    metadata: row.metadata
  };
}

export function generateApiKey(): { key: string; hash: string } {
  const random = randomBytes(18).toString('base64url').slice(0, 24);
  const key = `quack_${random}`;
  const hash = createHash('sha256').update(key).digest('hex');
  return { key, hash };
}

export async function createApiKey(owner: string, name?: string, permissions: string[] = ['registered']): Promise<{ key: string; record: ApiKey }> {
  const { key, hash } = generateApiKey();
  const id = randomUUID().slice(0, 8);
  
  await pool.query(
    `INSERT INTO api_keys (id, key_hash, owner, name, permissions)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, hash, owner, name, permissions]
  );
  
  return {
    key,
    record: { id, owner, name, permissions, createdAt: new Date(), revoked: false }
  };
}

export async function validateApiKey(key: string): Promise<{ valid: boolean; owner?: string; permissions?: string[] }> {
  const hash = createHash('sha256').update(key).digest('hex');
  const result = await pool.query(
    'SELECT * FROM api_keys WHERE key_hash = $1 AND revoked = false',
    [hash]
  );
  
  if (result.rows.length === 0) {
    return { valid: false };
  }
  
  const row = result.rows[0];
  await pool.query('UPDATE api_keys SET last_used = NOW() WHERE id = $1', [row.id]);
  
  return {
    valid: true,
    owner: row.owner,
    permissions: row.permissions || ['registered']
  };
}

export async function listApiKeys(owner: string): Promise<ApiKey[]> {
  const result = await pool.query(
    'SELECT * FROM api_keys WHERE owner = $1 AND revoked = false ORDER BY created_at DESC',
    [owner]
  );
  return result.rows.map(row => ({
    id: row.id,
    owner: row.owner,
    name: row.name,
    permissions: row.permissions || [],
    createdAt: row.created_at,
    lastUsed: row.last_used,
    revoked: row.revoked
  }));
}

export async function revokeApiKey(id: string, owner: string): Promise<boolean> {
  const result = await pool.query(
    'UPDATE api_keys SET revoked = true WHERE id = $1 AND owner = $2',
    [id, owner]
  );
  return (result.rowCount || 0) > 0;
}

export function signWebhookPayload(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

export { pool };
