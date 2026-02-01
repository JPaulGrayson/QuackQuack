/**
 * Quack Server - Fixed for MCP compatibility
 * 🦆 Agent-to-agent relay for vibe coders
 */

import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { createServer } from 'http';
import { ElevenLabsClient } from '@elevenlabs/elevenlabs-js';
import { 
  initStore, 
  sendMessage, 
  checkInbox, 
  receiveMessage, 
  completeMessage,
  approveMessage,
  updateMessageStatus,
  getMessage,
  deleteMessage,
  getAllInboxes,
  getStats,
  getThreadMessages,
  getAllThreads,
  runCleanup,
  validateInboxPath,
  resetAllData
} from './store.js';
import { SendMessageRequest, VALID_STATUSES, MessageStatus, QuackMessage, CoWorkRouteAction } from './types.js';
import { QuackStore, Dispatcher } from '../packages/@quack/core/dist/index.js';
import { handleMCPSSE, handleMCPMessage } from './mcp-handler.js';
import { initFileStore, uploadFile, getFile, getFileMeta } from './file-store.js';
import { initWebhooks, registerWebhook, removeWebhook, listWebhooks, triggerWebhooks } from './webhooks.js';
import { 
  initCoWorkStore, 
  registerAgent, 
  getAgent, 
  getAllAgents, 
  updateLastActivity,
  getCoWorkStats,
  deleteAgent,
  shouldAutoApprove,
  addRoutedMessage,
  getRoutedMessage,
  getRoutedMessagesForAgent,
  updateRoutedMessageStatus,
  removeRoutedMessage,
  getAllRoutedMessages
} from './cowork-store.js';
import {
  testConnection,
  listArchivedThreads,
  getArchivedThread,
  archiveThread,
  getAuditLogs,
  getAuditStats,
  logAudit,
  createAgent as createAgentDb,
  getAgent as getAgentDb,
  listAgents,
  updateAgent,
  deleteAgent as deleteAgentDb,
  pingAgent,
  createApiKey,
  validateApiKey,
  listApiKeys,
  revokeApiKey,
  signWebhookPayload
} from './db.js';
import startQuackRouter from './startQuack.js';
import { startGptProxy, stopGptProxy, getGptProxyStatus, processGptInbox } from './gpt-proxy.js';
import {
  initContextRecoveryTables,
  saveJournalEntry,
  getContextForSession,
  getContextForAgent,
  generateUniversalScript,
  closeSession,
  closeAgentSessions,
  startNewSession,
  getOrCreateSession,
  contextPool,
  AuditLogCreate
} from './context-recovery.js';
import { QuackBridge } from './quack-bridge.js';
import {
  initSessionRegistry,
  createSession,
  getSession,
  getSessionByThreadId,
  listSessions,
  getSessionsForAgent,
  getSessionStats,
  updateSessionStatus,
  recordSessionMessage,
  endSession,
  generateSessionKey,
} from './session-registry.js';

// ElevenLabs client for generating duck sounds
const elevenlabs = process.env.ELEVENLABS_API_KEY 
  ? new ElevenLabsClient({ apiKey: process.env.ELEVENLABS_API_KEY })
  : null;

const app = express();
const PORT = process.env.PORT || 5000;

// Health check - must be first for deployment
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public', {
  etag: false,
  lastModified: false,
  setHeaders: (res, path) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    if (path.endsWith('.md')) {
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    }
  }
}));

// Initialize stores
initStore();
initFileStore();
initWebhooks();
initCoWorkStore();
initSessionRegistry();
initContextRecoveryTables();

// Create QuackStore adapter for Dispatcher
const storeAdapter: QuackStore = {
  init: async () => {},
  sendMessage: async (req, from) => sendMessage(req, from),
  checkInbox: async (inbox, includeRead) => checkInbox(inbox, includeRead),
  getMessage: async (id) => getMessage(id),
  receiveMessage: async (id) => receiveMessage(id),
  completeMessage: async (id) => completeMessage(id),
  approveMessage: async (id) => approveMessage(id),
  updateMessageStatus: async (id, status) => updateMessageStatus(id, status),
  deleteMessage: async (id) => deleteMessage(id),
  getAllInboxes: async () => getAllInboxes(),
  getStats: async () => getStats(),
};

// Initialize Dispatcher for auto-triggering webhook agents
const dispatcher = new Dispatcher({ store: storeAdapter, pollInterval: 5000 });
// Register this Quack server's own /api/task endpoint for self-dispatching (demo/testing)
// In production, register external Replit app URLs here
dispatcher.registerWebhook('replit', `http://localhost:${PORT}`);
dispatcher.start();

// StartQuack monitoring router
app.use('/api/monitor', startQuackRouter);

// Auto-Wake webhook helper - notifies registered agents when they receive messages
async function triggerAutoWakeWebhook(inbox: string, message: { id: string; from: string; task: string; timestamp: string }): Promise<void> {
  try {
    // Normalize inbox path: remove leading slashes to match agent ID format (platform/name)
    const normalizedInbox = inbox.replace(/^\/+/, '');
    const agent = await getAgentDb(normalizedInbox);
    if (!agent?.webhook) return;
    
    const payload = JSON.stringify({
      event: 'new_message',
      inbox,
      from: message.from,
      messageId: message.id,
      task: message.task.substring(0, 200),
      timestamp: message.timestamp
    });
    
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (agent.webhookSecret) {
      headers['X-Quack-Signature'] = signWebhookPayload(payload, agent.webhookSecret);
    }
    
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    
    const response = await fetch(agent.webhook, {
      method: 'POST',
      headers,
      body: payload,
      signal: controller.signal
    });
    
    clearTimeout(timeout);
    
    console.log(`[AutoWake] Notified ${normalizedInbox} via ${agent.webhook} (status: ${response.status})`);
    
    await logAudit('message.send', 'system', 'webhook', normalizedInbox, {
      event: 'auto_wake_notification',
      webhookUrl: agent.webhook,
      status: response.status,
      messageId: message.id
    });
  } catch (err) {
    console.error(`[AutoWake] Failed to notify ${inbox}:`, err);
  }
}

// ============== REST API ==============

// Send a message
app.post('/api/send', (req, res) => {
  try {
    const request: SendMessageRequest = req.body;
    
    if (!request.to || !request.task) {
      return res.status(400).json({ error: 'Missing required fields: to, task' });
    }
    
    // Handle CoWork routing: to="cowork" with destination field
    if (request.to === 'cowork' || request.to === '/cowork') {
      if (!request.destination) {
        return res.status(400).json({ 
          error: 'Missing destination field for CoWork routing',
          hint: 'When to="cowork", you must specify destination (e.g., destination="claude")'
        });
      }
      
      // Create CoWork routed message
      const now = new Date();
      const expiresAt = new Date(now.getTime() + 48 * 60 * 60 * 1000);
      const id = crypto.randomUUID();
      
      const coworkMessage: QuackMessage = {
        id,
        to: 'cowork',
        from: request.from,
        timestamp: now.toISOString(),
        expiresAt: expiresAt.toISOString(),
        status: 'pending',
        task: request.task,
        context: request.context,
        files: request.files || [],
        project: request.project,
        priority: request.priority,
        tags: request.tags,
        routing: 'cowork',
        routedAt: now.toISOString(),
        destination: request.destination,
        coworkStatus: 'pending',
        threadId: id,
      };
      
      // Check destination agent config for auto-routing
      // Can be overridden with requireApproval flag from request
      const destAgent = request.destination.split('/')[0];
      const agentConfig = getAgent(destAgent);
      const shouldAutoRoute = agentConfig && !agentConfig.requiresApproval && !request.requireApproval;
      
      if (shouldAutoRoute) {
        // Auto-route to destination (autonomous agent)
        const destRequest: SendMessageRequest = {
          to: request.destination,
          from: request.from,
          task: request.task,
          context: request.context,
          files: request.files,
          project: request.project,
          priority: request.priority,
          tags: request.tags,
          routing: 'cowork',
        };
        const routedMsg = sendMessage(destRequest, request.from);
        
        return res.json({
          success: true,
          messageId: routedMsg.id,
          message: routedMsg,
          coworkRouted: true,
          autoApproved: true,
        });
      }
      
      // Hold for approval (conversational agent or requiresApproval=true)
      addRoutedMessage(coworkMessage);
      
      return res.json({
        success: true,
        messageId: coworkMessage.id,
        message: coworkMessage,
        coworkRouted: true,
        autoApproved: false,
        hint: 'Message held for approval. Use POST /api/cowork/route to approve/reject.',
      });
    }
    
    // Preserve full inbox path for conversational agents
    // e.g., claude/web stays as claude/web (no longer consolidated to root)
    // Extract project from path if not explicitly provided
    const targetInbox = request.to.replace(/^\/+/, ''); // Remove leading slashes
    const pathParts = targetInbox.split('/');
    
    if (pathParts.length >= 2 && !request.project) {
      // Use the second part of the path as project metadata if not set
      request.project = pathParts.slice(1).join('/');
    }
    
    // Validate inbox path format
    // Root inboxes (e.g., /claude) are allowed when project metadata is provided
    const hasProjectMetadata = !!(request.project || request.tags?.length);
    const pathValidation = validateInboxPath(request.to, hasProjectMetadata);
    if (!pathValidation.valid) {
      return res.status(400).json({ 
        error: pathValidation.error,
        hint: hasProjectMetadata ? 'Check inbox path format' : 'Use format: platform/application (e.g., "replit/orchestrate") or include project metadata for root inboxes'
      });
    }
    
    // Resolve file references if present
    let files = request.files || [];
    
    if (request.fileRefs && request.fileRefs.length > 0) {
      for (const fileId of request.fileRefs) {
        const fileData = getFile(fileId);
        if (fileData) {
          files.push({
            name: fileData.meta.name,
            content: fileData.content,
            type: fileData.meta.type,
            size: fileData.meta.size,
          });
        }
      }
    }
    
    // Create message with resolved files
    const messageRequest = { ...request, files };
    const message = sendMessage(messageRequest, request.from || 'api');
    
    // Trigger webhooks for this inbox (fire-and-forget with error handling)
    triggerWebhooks(req.body.to, message).catch(err => {
      console.error('Webhook trigger error:', err);
    });
    
    // Trigger Auto-Wake webhook if recipient agent has one registered
    triggerAutoWakeWebhook(request.to, {
      id: message.id,
      from: message.from,
      task: message.task,
      timestamp: message.timestamp
    }).catch(err => {
      console.error('AutoWake trigger error:', err);
    });
    
    res.json({
      success: true,
      messageId: message.id,
      message,
    });
  } catch (err) {
    console.error('Send error:', err);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// Check inbox - supports single level (e.g., /api/inbox/claude)
// Query params: includeRead=true, autoApprove=true
app.get('/api/inbox/:name', (req, res) => {
  const inbox = req.params.name;
  const includeRead = req.query.includeRead === 'true';
  const autoApprove = req.query.autoApprove === 'true';
  
  // Update last activity for this agent (CoWork tracking)
  const agentName = inbox.split('/')[0];
  updateLastActivity(agentName);
  
  const messages = checkInbox(inbox, includeRead, autoApprove);
  
  res.json({
    inbox,
    messages,
    count: messages.length,
  });
});

// Check inbox - supports two-level hierarchical paths (e.g., /api/inbox/claude/project-alpha)
// Query params: includeRead=true, autoApprove=true
app.get('/api/inbox/:parent/:child', (req, res) => {
  const inbox = `${req.params.parent}/${req.params.child}`;
  const includeRead = req.query.includeRead === 'true';
  const autoApprove = req.query.autoApprove === 'true';
  
  // Update last activity for this agent (CoWork tracking)
  updateLastActivity(req.params.parent);
  
  const messages = checkInbox(inbox, includeRead, autoApprove);
  
  res.json({
    inbox,
    messages,
    count: messages.length,
  });
});

// Check inbox - supports three-level hierarchical paths (e.g., /api/inbox/claude/project/subtask)
// Query params: includeRead=true, autoApprove=true
app.get('/api/inbox/:parent/:child/:subchild', (req, res) => {
  const inbox = `${req.params.parent}/${req.params.child}/${req.params.subchild}`;
  const includeRead = req.query.includeRead === 'true';
  const autoApprove = req.query.autoApprove === 'true';
  
  // Update last activity for this agent (CoWork tracking)
  updateLastActivity(req.params.parent);
  
  const messages = checkInbox(inbox, includeRead, autoApprove);
  
  res.json({
    inbox,
    messages,
    count: messages.length,
  });
});

// Get specific message
app.get('/api/message/:id', (req, res) => {
  const message = getMessage(req.params.id);
  
  if (!message) {
    return res.status(404).json({ error: 'Message not found' });
  }
  
  res.json(message);
});

// Receive message (mark as read)
app.post('/api/receive/:id', (req, res) => {
  const message = receiveMessage(req.params.id);
  
  if (!message) {
    return res.status(404).json({ error: 'Message not found' });
  }
  
  res.json({
    success: true,
    message,
  });
});

// Complete message
app.post('/api/complete/:id', (req, res) => {
  const message = completeMessage(req.params.id);
  
  if (!message) {
    return res.status(404).json({ error: 'Message not found' });
  }
  
  res.json({
    success: true,
    message,
  });
});

// Approve message (for Orchestrate integration)
app.post('/api/approve/:id', (req, res) => {
  const existingMessage = getMessage(req.params.id);
  
  if (!existingMessage) {
    return res.status(404).json({ success: false, error: 'Message not found' });
  }
  
  if (existingMessage.status !== 'pending') {
    return res.status(400).json({ 
      success: false, 
      error: `Message is already ${existingMessage.status}` 
    });
  }
  
  const message = approveMessage(req.params.id);
  
  if (!message) {
    return res.status(500).json({ success: false, error: 'Failed to approve message' });
  }
  
  // AUTO-PING: Trigger webhooks for the destination inbox on approval
  triggerWebhooks(message.to, message, 'message.approved').catch(err => {
    console.error('Approval webhook trigger error:', err);
  });
  
  const { userComment } = req.body || {};
  
  // Check if this message is an automation request itself - prevent recursive loop
  let isAutomationRequest = false;
  try {
    const parsed = JSON.parse(message.task || '');
    if (parsed.action === 'notify-agent') {
      isAutomationRequest = true;
    }
  } catch {
    // Not JSON, not an automation request
  }
  
  // Get target agent's platform info for automation
  const targetAgentName = message.to.replace(/^\//, '').split('/')[0];
  const targetAgent = getAgent(targetAgentName);
  
  // Check if Claude is online (checked inbox in last 5 minutes)
  const claude = getAgent('claude');
  const claudeOnline = claude?.lastActivity && 
    new Date(claude.lastActivity) > new Date(Date.now() - 5 * 60 * 1000);
  
  // Build enriched prompt for the target agent
  const shortId = req.params.id.slice(0, 8);
  const prompt = userComment 
    ? `quack id:${shortId} "${userComment}"`
    : `quack id:${shortId}`;
  
  // Skip automation for:
  // 1. Automation requests (prevent recursion)
  // 2. Conversational agents (they're already in the conversation, no need to wake them)
  const isTargetAutonomous = targetAgent?.category === 'autonomous';
  
  if (claudeOnline && targetAgent?.platformUrl && !isAutomationRequest && isTargetAutonomous) {
    // Send automation request to Claude's inbox
    const automationRequest = {
      action: 'notify-agent',
      target: message.to,
      messageId: req.params.id,
      platformUrl: targetAgent.platformUrl,
      prompt: prompt,
      messageSummary: message.task?.substring(0, 100) || ''
    };
    
    sendMessage({
      to: 'claude',
      from: 'quack/system',
      task: JSON.stringify(automationRequest),
      project: 'automation',
      priority: 'high',
      tags: ['automation', 'notify-agent']
    }, 'quack/system');
    
    console.log(`🤖 Automation request sent to Claude for ${message.to}`);
    
    return res.json({
      success: true,
      message,
      automation: 'requested',
      prompt,
      platformUrl: targetAgent.platformUrl,
      notifyPrompt: targetAgent.notifyPrompt
    });
  }
  
  // AUTO-PING FALLBACK: Send ping message to agent's inbox if no webhook registered
  // This wakes up agents when they next check their inbox
  if (!isAutomationRequest && message.to !== 'claude' && message.to !== 'quack/system') {
    const pingMessage = {
      to: message.to,
      from: 'quack/ping',
      task: `🔔 PING: Message approved! ID: ${shortId}. From: ${message.from}. Task: "${message.task?.substring(0, 80)}..."`,
      priority: 'high' as const,
      tags: ['ping', 'auto-notification']
    };
    
    // Don't await - fire and forget
    try {
      sendMessage(pingMessage, 'quack/ping');
      console.log(`🔔 Auto-ping sent to ${message.to} for approved message ${shortId}`);
    } catch (err) {
      console.error('Auto-ping error:', err);
    }
  }
  
  // Return response with notification status
  res.json({
    success: true,
    message,
    automation: claudeOnline && isTargetAutonomous ? 'webhook' : 'ping',
    prompt,
    platformUrl: targetAgent?.platformUrl,
    notifyPrompt: targetAgent?.notifyPrompt,
    pingDelivered: true
  });
});

// Valid status transitions enforcing workflow: pending → approved → in_progress → completed/failed
const STATUS_TRANSITIONS: Record<string, string[]> = {
  'pending': ['approved', 'failed'],           // Must be approved first, or can fail (reject)
  'approved': ['in_progress', 'failed'],       // Start work or fail
  'in_progress': ['completed', 'failed'],      // Finish or fail
  'read': ['in_progress'],                     // Legacy: start work from read state
  'completed': [],                             // Terminal state
  'failed': ['pending'],                       // Can retry (back to pending for re-approval)
};

// Update message status (general purpose with transition validation)
app.post('/api/status/:id', (req, res) => {
  const { status } = req.body;
  
  if (!status) {
    return res.status(400).json({ success: false, error: 'Missing status field' });
  }
  
  if (!VALID_STATUSES.includes(status as MessageStatus)) {
    return res.status(400).json({ 
      success: false, 
      error: `Invalid status. Valid options: ${VALID_STATUSES.join(', ')}` 
    });
  }
  
  // Get current message to check transition
  const existingMessage = getMessage(req.params.id);
  if (!existingMessage) {
    return res.status(404).json({ success: false, error: 'Message not found' });
  }
  
  // Validate status transition
  const allowedTransitions = STATUS_TRANSITIONS[existingMessage.status] || [];
  if (!allowedTransitions.includes(status)) {
    return res.status(400).json({ 
      success: false, 
      error: `Cannot transition from '${existingMessage.status}' to '${status}'. Allowed: ${allowedTransitions.join(', ') || 'none'}` 
    });
  }
  
  const message = updateMessageStatus(req.params.id, status as MessageStatus);
  
  res.json({
    success: true,
    message,
  });
});

// Delete message
app.delete('/api/message/:id', (req, res) => {
  const deleted = deleteMessage(req.params.id);
  
  if (!deleted) {
    return res.status(404).json({ error: 'Message not found' });
  }
  
  res.json({ success: true });
});

// Get all inboxes
app.get('/api/inboxes', (req, res) => {
  res.json({
    inboxes: getAllInboxes(),
  });
});

// Stats
app.get('/api/stats', (req, res) => {
  res.json(getStats());
});

// Cleanup expired messages and empty inboxes
app.post('/api/cleanup', (req, res) => {
  const result = runCleanup();
  res.json({
    success: true,
    cleaned: result.cleaned,
    removedInboxes: result.removedInboxes,
  });
});

// Admin reset - clears ALL data
app.post('/api/admin/reset', (req, res) => {
  const result = resetAllData();
  res.json({
    success: true,
    message: 'All data has been reset',
    cleared: result.cleared,
  });
});

// ============== THREADING ENDPOINTS ==============

// Get all threads
app.get('/api/threads', (req, res) => {
  const threads = getAllThreads();
  res.json({
    threads,
    count: threads.length,
  });
});

// Get messages in a specific thread
app.get('/api/thread/:threadId', (req, res) => {
  const messages = getThreadMessages(req.params.threadId);
  
  if (messages.length === 0) {
    return res.status(404).json({ error: 'Thread not found' });
  }
  
  res.json({
    threadId: req.params.threadId,
    messages,
    count: messages.length,
  });
});

// ============== SESSION API ENDPOINTS ==============

// List sessions (like OpenClaw's sessions_list)
app.get('/api/sessions', (req, res) => {
  try {
    const options = {
      kinds: req.query.kinds ? (req.query.kinds as string).split(',') as any[] : undefined,
      participant: req.query.participant as string,
      limit: req.query.limit ? parseInt(req.query.limit as string) : 50,
      activeMinutes: req.query.activeMinutes ? parseInt(req.query.activeMinutes as string) : undefined,
      includeCompleted: req.query.includeCompleted === 'true',
    };
    
    const sessions = listSessions(options);
    res.json({
      sessions,
      count: sessions.length,
    });
  } catch (err) {
    console.error('Failed to list sessions:', err);
    res.status(500).json({ error: 'Failed to list sessions' });
  }
});

// Get session stats
app.get('/api/sessions/stats', (req, res) => {
  try {
    const stats = getSessionStats();
    res.json(stats);
  } catch (err) {
    console.error('Failed to get session stats:', err);
    res.status(500).json({ error: 'Failed to get session stats' });
  }
});

// Get session by key
app.get('/api/sessions/key/:key', (req, res) => {
  try {
    const session = getSession(decodeURIComponent(req.params.key));
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }
    res.json(session);
  } catch (err) {
    console.error('Failed to get session:', err);
    res.status(500).json({ error: 'Failed to get session' });
  }
});

// Get session by thread ID
app.get('/api/sessions/thread/:threadId', (req, res) => {
  try {
    const session = getSessionByThreadId(req.params.threadId);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }
    res.json(session);
  } catch (err) {
    console.error('Failed to get session:', err);
    res.status(500).json({ error: 'Failed to get session' });
  }
});

// Get sessions for an agent
app.get('/api/sessions/agent/:agent', (req, res) => {
  try {
    const agent = decodeURIComponent(req.params.agent);
    const sessions = getSessionsForAgent(agent);
    res.json({
      agent,
      sessions,
      count: sessions.length,
    });
  } catch (err) {
    console.error('Failed to get agent sessions:', err);
    res.status(500).json({ error: 'Failed to get agent sessions' });
  }
});

// End a session
app.post('/api/sessions/:sessionKey/end', (req, res) => {
  try {
    const sessionKey = decodeURIComponent(req.params.sessionKey);
    const { by, reason } = req.body;
    
    const session = endSession(sessionKey, by || 'api', reason || 'manual');
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }
    
    res.json({
      success: true,
      session,
    });
  } catch (err) {
    console.error('Failed to end session:', err);
    res.status(500).json({ error: 'Failed to end session' });
  }
});

// Update session status
app.patch('/api/sessions/:sessionKey/status', (req, res) => {
  try {
    const sessionKey = decodeURIComponent(req.params.sessionKey);
    const { status, currentTurn } = req.body;
    
    if (!status) {
      return res.status(400).json({ error: 'Status is required' });
    }
    
    const session = updateSessionStatus(sessionKey, status, { currentTurn });
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }
    
    res.json({
      success: true,
      session,
    });
  } catch (err) {
    console.error('Failed to update session status:', err);
    res.status(500).json({ error: 'Failed to update session status' });
  }
});

// ============== DISPATCHER TASK ENDPOINT ==============

// Receive task from Dispatcher (called when messages to /replit are approved)
app.post('/api/task', async (req, res) => {
  const { messageId, task, context, from, to, files } = req.body;
  
  console.log(`📥 Task received from ${from}: ${messageId}`);
  console.log(`   Task: ${task?.substring(0, 100)}...`);
  
  // Acknowledge receipt immediately
  res.json({ 
    success: true, 
    message: 'Task received and queued for processing',
    messageId 
  });
  
  // In a real implementation, this would trigger the Replit agent to process the task
  // For now, we just log it - the calling app should implement actual task processing
  // and call /api/status/:id with 'completed' or 'failed' when done
});

// Dispatcher status endpoint
app.get('/api/dispatcher/status', (req, res) => {
  res.json({
    running: dispatcher.isRunning(),
    webhooks: dispatcher.getRegisteredWebhooks(),
  });
});

// Register a webhook for dispatcher
app.post('/api/dispatcher/webhook', (req, res) => {
  const { agent, baseUrl } = req.body;
  
  if (!agent || !baseUrl) {
    return res.status(400).json({ error: 'Missing required fields: agent, baseUrl' });
  }
  
  dispatcher.registerWebhook(agent, baseUrl);
  res.json({ success: true, agent, baseUrl });
});

// ============== AGENT REGISTRY API ==============

// Authentication middleware
const devBypass = process.env.BRIDGE_DEV_BYPASS === 'true';

async function extractAuth(req: express.Request): Promise<{ authenticated: boolean; owner?: string; permissions?: string[] }> {
  const authHeader = req.headers.authorization;
  const tokenParam = req.query.token as string;
  
  const key = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : tokenParam;
  
  if (!key) {
    return { authenticated: false };
  }
  
  const result = await validateApiKey(key);
  return { authenticated: result.valid, owner: result.owner, permissions: result.permissions };
}

function requireAuth(level: 'registered' | 'owner' | 'admin' = 'registered') {
  return async (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (devBypass) {
      (req as any).auth = { authenticated: true, owner: 'dev', permissions: ['admin'] };
      return next();
    }
    
    const auth = await extractAuth(req);
    
    if (!auth.authenticated) {
      return res.status(401).json({ error: 'Authentication required', hint: 'Use Authorization: Bearer quack_xxx header or ?token=quack_xxx query param' });
    }
    
    if (level === 'admin' && !auth.permissions?.includes('admin')) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    
    (req as any).auth = auth;
    next();
  };
}

// List all public agents (no auth required)
app.get('/api/agents', async (req, res) => {
  try {
    const agents = await listAgents({ publicOnly: true });
    res.json({ agents, count: agents.length });
  } catch (err) {
    console.error('[Agents] List error:', err);
    res.status(500).json({ error: 'Failed to list agents' });
  }
});

// Get single agent (no auth required for public agents)
app.get('/api/agents/:platform/:name', async (req, res) => {
  try {
    const id = `${req.params.platform}/${req.params.name}`;
    const agent = await getAgentDb(id);
    
    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }
    
    if (!agent.public) {
      const auth = await extractAuth(req);
      if (!auth.authenticated || (auth.owner !== agent.owner && !auth.permissions?.includes('admin'))) {
        return res.status(404).json({ error: 'Agent not found' });
      }
    }
    
    const sanitized = { ...agent };
    delete (sanitized as any).webhookSecret;
    res.json(sanitized);
  } catch (err) {
    console.error('[Agents] Get error:', err);
    res.status(500).json({ error: 'Failed to get agent' });
  }
});

// Register new agent (requires auth)
app.post('/api/agents', requireAuth('registered'), async (req, res) => {
  try {
    const auth = (req as any).auth;
    const { id, name, platform, capabilities, public: isPublic, webhook, webhookSecret, metadata } = req.body;
    
    if (!id || !name || !platform) {
      return res.status(400).json({ error: 'Missing required fields: id, name, platform' });
    }
    
    const existing = await getAgentDb(id);
    if (existing) {
      return res.status(409).json({ error: 'Agent with this ID already exists' });
    }
    
    const agent = await createAgentDb({
      id,
      name,
      platform,
      capabilities: capabilities || [],
      status: 'unknown',
      public: isPublic !== false,
      owner: auth.owner,
      webhook,
      webhookSecret,
      metadata
    });
    
    await logAudit('agent.register', auth.owner, 'agent', id, { name, platform });
    
    const sanitized = { ...agent };
    delete (sanitized as any).webhookSecret;
    res.status(201).json(sanitized);
  } catch (err) {
    console.error('[Agents] Create error:', err);
    res.status(500).json({ error: 'Failed to create agent' });
  }
});

// Update agent (owner only)
app.put('/api/agents/:platform/:name', requireAuth('registered'), async (req, res) => {
  try {
    const auth = (req as any).auth;
    const id = `${req.params.platform}/${req.params.name}`;
    
    const existing = await getAgentDb(id);
    if (!existing) {
      return res.status(404).json({ error: 'Agent not found' });
    }
    
    if (existing.owner !== auth.owner && !auth.permissions?.includes('admin')) {
      return res.status(403).json({ error: 'Only the owner can update this agent' });
    }
    
    const { name, platform, capabilities, status, public: isPublic, webhook, webhookSecret, metadata } = req.body;
    
    const agent = await updateAgent(id, {
      name,
      platform,
      capabilities,
      status,
      public: isPublic,
      webhook,
      webhookSecret,
      metadata
    });
    
    await logAudit('agent.update', auth.owner, 'agent', id, req.body);
    
    const sanitized = { ...agent };
    delete (sanitized as any).webhookSecret;
    res.json(sanitized);
  } catch (err) {
    console.error('[Agents] Update error:', err);
    res.status(500).json({ error: 'Failed to update agent' });
  }
});

// Delete agent (owner only)
app.delete('/api/agents/:platform/:name', requireAuth('registered'), async (req, res) => {
  try {
    const auth = (req as any).auth;
    const id = `${req.params.platform}/${req.params.name}`;
    
    const existing = await getAgentDb(id);
    if (!existing) {
      return res.status(404).json({ error: 'Agent not found' });
    }
    
    if (existing.owner !== auth.owner && !auth.permissions?.includes('admin')) {
      return res.status(403).json({ error: 'Only the owner can delete this agent' });
    }
    
    await deleteAgentDb(id);
    await logAudit('agent.delete', auth.owner, 'agent', id, {});
    
    res.json({ success: true, message: 'Agent deleted' });
  } catch (err) {
    console.error('[Agents] Delete error:', err);
    res.status(500).json({ error: 'Failed to delete agent' });
  }
});

// Ping agent (update lastSeen)
app.post('/api/agents/:platform/:name/ping', requireAuth('registered'), async (req, res) => {
  try {
    const auth = (req as any).auth;
    const id = `${req.params.platform}/${req.params.name}`;
    
    const existing = await getAgentDb(id);
    if (!existing) {
      return res.status(404).json({ error: 'Agent not found' });
    }
    
    if (existing.owner !== auth.owner && !auth.permissions?.includes('admin')) {
      return res.status(403).json({ error: 'Only the owner can ping this agent' });
    }
    
    const agent = await pingAgent(id);
    
    const sanitized = { ...agent };
    delete (sanitized as any).webhookSecret;
    res.json(sanitized);
  } catch (err) {
    console.error('[Agents] Ping error:', err);
    res.status(500).json({ error: 'Failed to ping agent' });
  }
});

// ============== API KEY MANAGEMENT ==============

// Generate new API key (admin only for now)
app.post('/api/keys', requireAuth('admin'), async (req, res) => {
  try {
    const auth = (req as any).auth;
    const { owner, name, permissions } = req.body;
    
    if (!owner) {
      return res.status(400).json({ error: 'Missing required field: owner' });
    }
    
    const result = await createApiKey(owner, name, permissions);
    
    res.status(201).json({
      success: true,
      key: result.key,
      record: result.record,
      warning: 'Store this key securely - it will not be shown again'
    });
  } catch (err) {
    console.error('[Keys] Create error:', err);
    res.status(500).json({ error: 'Failed to create API key' });
  }
});

// List your API keys
app.get('/api/keys', requireAuth('registered'), async (req, res) => {
  try {
    const auth = (req as any).auth;
    const keys = await listApiKeys(auth.owner);
    res.json({ keys, count: keys.length });
  } catch (err) {
    console.error('[Keys] List error:', err);
    res.status(500).json({ error: 'Failed to list keys' });
  }
});

// Revoke an API key
app.delete('/api/keys/:id', requireAuth('registered'), async (req, res) => {
  try {
    const auth = (req as any).auth;
    const keyId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const revoked = await revokeApiKey(keyId, auth.owner || '');
    
    if (!revoked) {
      return res.status(404).json({ error: 'Key not found or already revoked' });
    }
    
    res.json({ success: true, message: 'API key revoked' });
  } catch (err) {
    console.error('[Keys] Revoke error:', err);
    res.status(500).json({ error: 'Failed to revoke key' });
  }
});

// ============== COWORK API ==============

// Register an agent
app.post('/api/cowork/agents', (req, res) => {
  try {
    const { name, category, requiresApproval, autoApproveOnCheck, notifyVia, webhookUrl } = req.body;
    
    if (!name) {
      return res.status(400).json({ error: 'Missing required field: name' });
    }
    
    const agent = registerAgent({
      name,
      category: category || 'autonomous',
      requiresApproval: requiresApproval ?? false,
      autoApproveOnCheck: autoApproveOnCheck ?? true,
      notifyVia: notifyVia || 'polling',
      webhookUrl,
    });
    
    res.json({ success: true, agent });
  } catch (err) {
    console.error('Agent registration error:', err);
    res.status(500).json({ error: 'Failed to register agent' });
  }
});

// List all registered agents
app.get('/api/cowork/agents', (req, res) => {
  const agents = getAllAgents();
  res.json({ agents, count: agents.length });
});

// Get a specific agent
app.get('/api/cowork/agents/:name', (req, res) => {
  const agent = getAgent(req.params.name);
  
  if (!agent) {
    return res.status(404).json({ error: 'Agent not found' });
  }
  
  res.json({ agent });
});

// Delete an agent
app.delete('/api/cowork/agents/:name', (req, res) => {
  const deleted = deleteAgent(req.params.name);
  
  if (!deleted) {
    return res.status(404).json({ error: 'Agent not found' });
  }
  
  res.json({ success: true, deleted: req.params.name });
});

// Get CoWork status
app.get('/api/cowork/status', (req, res) => {
  const stats = getCoWorkStats();
  const msgStats = getStats();
  
  res.json({
    agents: stats,
    messages: {
      pending: msgStats.pending,
      approved: msgStats.approved,
      inProgress: msgStats.inProgress,
    },
  });
});

// Ping endpoint - agents call this to update their "last seen" status
app.post('/api/cowork/ping/:agent', (req, res) => {
  const agentName = req.params.agent;
  updateLastActivity(agentName);
  res.json({ success: true, agent: agentName, timestamp: new Date().toISOString() });
});

// Get CoWork-routed messages for an agent
app.get('/api/cowork/messages', (req, res) => {
  const destination = req.query.destination as string;
  
  if (!destination) {
    // Return all routed messages
    const messages = getAllRoutedMessages();
    return res.json({ messages, count: messages.length });
  }
  
  // Update last activity for this agent
  const agentName = destination.split('/')[0];
  updateLastActivity(agentName);
  
  const messages = getRoutedMessagesForAgent(destination);
  res.json({ 
    destination, 
    messages, 
    count: messages.length 
  });
});

// Manual routing decision from Control Room
app.post('/api/cowork/route', (req, res) => {
  try {
    const { messageId, action, forwardTo } = req.body as { 
      messageId: string; 
      action: CoWorkRouteAction;
      forwardTo?: string;  // destination when action='forward'
    };
    
    if (!messageId || !action) {
      return res.status(400).json({ error: 'Missing required fields: messageId, action' });
    }
    
    if (!['approve', 'reject', 'forward'].includes(action)) {
      return res.status(400).json({ error: 'Invalid action. Must be: approve, reject, or forward' });
    }
    
    const message = getRoutedMessage(messageId);
    if (!message) {
      return res.status(404).json({ error: 'Message not found in CoWork routing' });
    }
    
    // Update CoWork status
    const updatedMessage = updateRoutedMessageStatus(messageId, action);
    
    if (action === 'approve' && message.destination) {
      // Route to destination inbox
      const destRequest: SendMessageRequest = {
        to: message.destination,
        from: message.from,
        task: message.task,
        context: message.context,
        files: message.files,
        project: message.project,
        priority: message.priority,
        tags: message.tags,
        routing: 'cowork',
      };
      const routedMsg = sendMessage(destRequest, message.from);
      
      // Remove from CoWork pending
      removeRoutedMessage(messageId);
      
      return res.json({ 
        success: true, 
        action,
        originalId: messageId,
        routedMessage: routedMsg,
      });
    }
    
    if (action === 'forward') {
      if (!forwardTo) {
        return res.status(400).json({ 
          error: 'Missing forwardTo field for forward action',
          hint: 'Specify forwardTo to indicate where to forward the message'
        });
      }
      // Forward to different destination
      const fwdRequest: SendMessageRequest = {
        to: forwardTo,
        from: message.from,
        task: message.task,
        context: message.context,
        files: message.files,
        project: message.project,
        priority: message.priority,
        tags: message.tags,
        routing: 'cowork',
      };
      const forwardedMsg = sendMessage(fwdRequest, message.from);
      
      // Remove from CoWork pending
      removeRoutedMessage(messageId);
      
      return res.json({ 
        success: true, 
        action,
        originalId: messageId,
        forwardedTo: forwardTo,
        routedMessage: forwardedMsg,
      });
    }
    
    if (action === 'reject') {
      // Just remove from CoWork routing
      removeRoutedMessage(messageId);
      return res.json({ 
        success: true, 
        action,
        messageId,
      });
    }
    
    res.json({ success: true, action, message: updatedMessage });
  } catch (err) {
    console.error('CoWork route error:', err);
    res.status(500).json({ error: 'Failed to route message' });
  }
});

// ============== FILE UPLOAD API ==============

// Upload a file (returns fileId for use in messages)
app.post('/api/files', (req, res) => {
  try {
    const { name, content, type, mimeType } = req.body;
    
    if (!name || !content || !type) {
      return res.status(400).json({ 
        error: 'Missing required fields: name, content, type' 
      });
    }
    
    const file = uploadFile(name, content, type, mimeType);
    
    res.json({
      success: true,
      fileId: file.id,
      file: {
        id: file.id,
        name: file.name,
        type: file.type,
        size: file.size,
        expiresAt: file.expiresAt,
      },
    });
  } catch (err) {
    console.error('File upload error:', err);
    res.status(500).json({ error: 'Failed to upload file' });
  }
});

// Get file content
app.get('/api/files/:id', (req, res) => {
  const result = getFile(req.params.id);
  
  if (!result) {
    return res.status(404).json({ error: 'File not found' });
  }
  
  res.json({
    ...result.meta,
    content: result.content,
  });
});

// Get file metadata only (no content)
app.get('/api/files/:id/meta', (req, res) => {
  const meta = getFileMeta(req.params.id);
  
  if (!meta) {
    return res.status(404).json({ error: 'File not found' });
  }
  
  res.json(meta);
});

// ============== WEBHOOK API ==============

// Register a webhook
app.post('/api/webhooks', (req, res) => {
  try {
    const { inbox, url, secret } = req.body;
    
    if (!inbox || !url) {
      return res.status(400).json({ error: 'Missing required fields: inbox, url' });
    }
    
    let webhook;
    try {
      webhook = registerWebhook(inbox, url, secret);
    } catch (err: any) {
      return res.status(400).json({ error: err.message });
    }
    
    res.json({
      success: true,
      webhook: {
        id: webhook.id,
        inbox: webhook.inbox,
        url: webhook.url,
        createdAt: webhook.createdAt,
      },
    });
  } catch (err) {
    console.error('Webhook register error:', err);
    res.status(500).json({ error: 'Failed to register webhook' });
  }
});

// List webhooks
app.get('/api/webhooks', (req, res) => {
  const webhooks = listWebhooks().map(w => ({
    id: w.id,
    inbox: w.inbox,
    url: w.url,
    createdAt: w.createdAt,
    lastTriggered: w.lastTriggered,
    failCount: w.failCount,
  }));
  
  res.json({ webhooks });
});

// Delete a webhook
app.delete('/api/webhooks/:id', (req, res) => {
  const deleted = removeWebhook(req.params.id);
  
  if (!deleted) {
    return res.status(404).json({ error: 'Webhook not found' });
  }
  
  res.json({ success: true });
});

// ============== Voyai Integration (Server-to-Server Session Handshake) ==============
// This implements the same pattern that works for Turai - no JWT in URL

interface VoyaiSessionData {
  voyaiUserId: string;
  email: string;
  tier: 'free' | 'premium';
  features: {
    universal_inbox: boolean;
    notifications: boolean;
    workflow_management: boolean;
    file_attachments: boolean;
    control_room: boolean;
    multi_inbox: boolean;
    auto_dispatch: boolean;
    toast_notifications: boolean;
  };
}

// In-memory session store for Voyai sessions (use Redis in production)
const pendingVoyaiSessions = new Map<string, {
  data: VoyaiSessionData;
  createdAt: number;
  expiresAt: number;
}>();

// Cleanup expired sessions every minute
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of pendingVoyaiSessions.entries()) {
    if (now > session.expiresAt) {
      pendingVoyaiSessions.delete(id);
    }
  }
}, 60000);

// Voyai calls this endpoint server-to-server to create a session
// NOTE: Sign-in disabled until re-enabled - uncomment auth check when ready
app.post('/api/voyai/session', (req, res) => {
  // Verify the request is from Voyai using API key
  const authHeader = req.headers.authorization;
  const expectedKey = process.env.VOYAI_API_KEY;
  
  if (!authHeader || authHeader !== `Bearer ${expectedKey}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  const sessionData: VoyaiSessionData = req.body;
  
  // Validate required fields
  if (!sessionData.email || !sessionData.voyaiUserId) {
    return res.status(400).json({ error: 'Missing required fields: email and voyaiUserId' });
  }
  
  // Generate a short, random session ID
  const sessionId = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes
  
  // Store the session
  pendingVoyaiSessions.set(sessionId, {
    data: sessionData,
    createdAt: Date.now(),
    expiresAt
  });
  
  console.log(`[Voyai Session] Created session ${sessionId.substring(0, 8)}... for ${sessionData.email}`);
  
  // Return session ID to Voyai
  res.json({
    success: true,
    data: {
      sessionId,
      expiresAt: new Date(expiresAt).toISOString()
    }
  });
});

// Quack frontend calls this to claim the session (one-time use)
app.get('/api/voyai/claim-session', (req, res) => {
  const sessionId = req.query.session as string;
  
  if (!sessionId) {
    return res.status(400).json({ error: 'Session ID required' });
  }
  
  const session = pendingVoyaiSessions.get(sessionId);
  
  if (!session) {
    return res.status(404).json({ error: 'Session not found or expired' });
  }
  
  if (Date.now() > session.expiresAt) {
    pendingVoyaiSessions.delete(sessionId);
    return res.status(410).json({ error: 'Session expired' });
  }
  
  // Delete the session (one-time use)
  pendingVoyaiSessions.delete(sessionId);
  
  console.log(`[Voyai Session] Claimed session for ${session.data.email}`);
  
  // Return the user data
  res.json({
    success: true,
    user: session.data
  });
});

// Legacy registration endpoint (for lead gen)
app.post('/api/voyai/register', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }
    
    const response = await fetch('https://voyai.org/api/quack/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email })
    });
    
    const data = await response.json();
    res.json(data);
  } catch (error: any) {
    console.error('Voyai register error:', error);
    res.status(500).json({ error: 'Failed to register with Voyai', details: error.message });
  }
});

// ============== SSE Test ==============

app.get('/api/sse-test', (req, res) => {
  console.log('SSE TEST HIT');
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');  
  res.flushHeaders();
  res.write('data: hello\n\n');
});

// ============== MCP Endpoints ==============

// SSE endpoint for mcp-remote connection
app.get('/api/mcp/sse', handleMCPSSE);

// POST endpoint for MCP messages from mcp-remote
app.post('/api/mcp/message', handleMCPMessage);

// ============== Sound Effects (ElevenLabs) ==============

const SOUNDS_DIR = path.join(process.cwd(), 'public', 'sounds');
const soundCache: Map<string, boolean> = new Map();

// Helper to convert stream to buffer
async function streamToBuffer(stream: any): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

// Generate a duck sound using ElevenLabs
async function generateDuckSound(type: string): Promise<string | null> {
  if (!elevenlabs) {
    console.log('ElevenLabs not configured - skipping sound generation');
    return null;
  }

  const soundPath = path.join(SOUNDS_DIR, `${type}.mp3`);
  
  // Check cache first
  if (fs.existsSync(soundPath)) {
    return soundPath;
  }

  const prompts: Record<string, { text: string; duration: number }> = {
    'send': { text: 'single short duck quack, one quick quack sound effect, crisp and clear', duration: 0.5 },
    'receive': { text: 'two quick duck quacks in a row, quack quack, happy duck sounds', duration: 1 },
    'fail': { text: 'sad disappointed duck, wah wah wah, descending pitch, cartoon failure sound, duck version', duration: 1.5 },
  };

  const config = prompts[type] || prompts['send'];

  try {
    console.log(`Generating duck sound: ${type}...`);
    const audio = await elevenlabs.textToSoundEffects.convert({
      text: config.text,
      durationSeconds: config.duration,
      promptInfluence: 0.7,
    });

    const buffer = await streamToBuffer(audio);
    
    // Ensure sounds directory exists
    if (!fs.existsSync(SOUNDS_DIR)) {
      fs.mkdirSync(SOUNDS_DIR, { recursive: true });
    }
    
    fs.writeFileSync(soundPath, buffer);
    soundCache.set(type, true);
    console.log(`Duck sound generated: ${type}`);
    return soundPath;
  } catch (error) {
    console.error(`Failed to generate sound ${type}:`, error);
    return null;
  }
}

// Endpoint to get duck sounds (generates on first request)
app.get('/api/sounds/:type', async (req, res) => {
  const { type } = req.params;
  const validTypes = ['send', 'receive', 'fail'];
  
  if (!validTypes.includes(type)) {
    return res.status(400).json({ error: 'Invalid sound type. Use: send, receive, or fail' });
  }

  const soundPath = path.join(SOUNDS_DIR, `${type}.mp3`);
  
  // If sound exists, serve it
  if (fs.existsSync(soundPath)) {
    return res.sendFile(soundPath);
  }

  // Generate the sound
  const generated = await generateDuckSound(type);
  if (generated) {
    return res.sendFile(generated);
  }

  res.status(503).json({ error: 'Sound generation unavailable' });
});

// Pre-generate all sounds on startup (background)
async function preGenerateSounds() {
  if (!elevenlabs) return;
  
  const types = ['send', 'receive', 'fail'];
  console.log('Pre-generating duck sounds...');
  
  for (const type of types) {
    const soundPath = path.join(SOUNDS_DIR, `${type}.mp3`);
    if (!fs.existsSync(soundPath)) {
      await generateDuckSound(type);
      // Small delay between API calls
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  console.log('Duck sounds ready!');
}

// Start pre-generation in background
setTimeout(preGenerateSounds, 2000);

// ============== Archive & Audit API ==============

app.get('/api/archive/threads', async (req, res) => {
  try {
    const options = {
      limit: parseInt(req.query.limit as string) || 50,
      offset: parseInt(req.query.offset as string) || 0,
      participant: req.query.participant as string,
      since: req.query.since ? new Date(req.query.since as string) : undefined,
      until: req.query.until ? new Date(req.query.until as string) : undefined
    };
    
    const result = await listArchivedThreads(options);
    res.json(result);
  } catch (e) {
    console.error('Failed to list archived threads:', e);
    res.status(500).json({ error: 'Failed to list archived threads' });
  }
});

app.get('/api/archive/threads/:threadId', async (req, res) => {
  try {
    const thread = await getArchivedThread(req.params.threadId);
    if (!thread) {
      return res.status(404).json({ error: 'Archived thread not found' });
    }
    res.json({ thread });
  } catch (e) {
    console.error('Failed to get archived thread:', e);
    res.status(500).json({ error: 'Failed to get archived thread' });
  }
});

app.post('/api/archive/threads/:threadId', async (req, res) => {
  try {
    const threadId = req.params.threadId;
    const messages = getThreadMessages(threadId);
    
    if (messages.length === 0) {
      return res.status(404).json({ error: 'Thread not found or has no messages' });
    }
    
    const archiveId = await archiveThread(threadId, messages, req.body.metadata || {});
    
    await logAudit('thread.archive', 'user', 'thread', threadId, {
      archiveId,
      messageCount: messages.length
    });
    
    res.json({ 
      success: true, 
      archiveId,
      messageCount: messages.length 
    });
  } catch (e) {
    console.error('Failed to archive thread:', e);
    res.status(500).json({ error: 'Failed to archive thread' });
  }
});

app.get('/api/audit/logs', async (req, res) => {
  try {
    const options = {
      limit: parseInt(req.query.limit as string) || 100,
      offset: parseInt(req.query.offset as string) || 0,
      action: req.query.action as string,
      actor: req.query.actor as string,
      targetType: req.query.targetType as string,
      targetId: req.query.targetId as string,
      since: req.query.since ? new Date(req.query.since as string) : undefined,
      until: req.query.until ? new Date(req.query.until as string) : undefined
    };
    
    const result = await getAuditLogs(options);
    res.json(result);
  } catch (e) {
    console.error('Failed to get audit logs:', e);
    res.status(500).json({ error: 'Failed to get audit logs' });
  }
});

app.get('/api/audit/stats', async (req, res) => {
  try {
    const stats = await getAuditStats();
    res.json(stats);
  } catch (e) {
    console.error('Failed to get audit stats:', e);
    res.status(500).json({ error: 'Failed to get audit stats' });
  }
});

app.get('/api/db/status', async (req, res) => {
  const connected = await testConnection();
  res.json({ 
    connected,
    status: connected ? 'healthy' : 'disconnected'
  });
});

// ============== GPT Proxy API ==============

app.get('/api/gpt-proxy/status', (req, res) => {
  const status = getGptProxyStatus();
  res.json(status);
});

app.post('/api/gpt-proxy/start', (req, res) => {
  const { pollIntervalMs, model, systemPrompt } = req.body || {};
  startGptProxy({ pollIntervalMs, model, systemPrompt });
  res.json({ success: true, message: 'GPT Proxy started', ...getGptProxyStatus() });
});

app.post('/api/gpt-proxy/stop', (req, res) => {
  stopGptProxy();
  res.json({ success: true, message: 'GPT Proxy stopped', ...getGptProxyStatus() });
});

app.post('/api/gpt-proxy/process', async (req, res) => {
  try {
    const result = await processGptInbox(req.body || {});
    res.json({ success: true, ...result });
  } catch (error: any) {
    console.error('GPT Proxy process error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============== Context Recovery API ==============

app.post('/api/v1/agent/journal', async (req, res) => {
  try {
    const entry: AuditLogCreate = req.body;
    
    if (!entry.agent_id || !entry.type || !entry.content) {
      return res.status(400).json({ error: 'Missing required fields: agent_id, type, content' });
    }
    
    const logEntry = await saveJournalEntry(entry);
    res.json(logEntry);
  } catch (error: any) {
    console.error('Journal entry error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/v1/agent/context/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const limit = parseInt(req.query.limit as string) || 50;
    
    const context = await getContextForSession(sessionId, limit);
    res.json(context);
  } catch (error: any) {
    if (error.message === 'Session not found') {
      return res.status(404).json({ error: 'Session not found' });
    }
    console.error('Context fetch error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/v1/agent/context/agent/:agentId', async (req, res) => {
  try {
    const { agentId } = req.params;
    const limit = parseInt(req.query.limit as string) || 50;
    
    const context = await getContextForAgent(agentId, limit);
    res.json(context);
  } catch (error: any) {
    if (error.message === 'No sessions found for agent') {
      return res.status(404).json({ error: 'No sessions found for agent' });
    }
    console.error('Agent context fetch error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/v1/agent/script/:agentId', async (req, res) => {
  try {
    const { agentId } = req.params;
    const includeContext = req.query.include_context !== 'false';
    
    let context = null;
    if (includeContext) {
      try {
        context = await getContextForAgent(agentId, 20);
      } catch (e) {
        // No prior context, that's fine
      }
    }
    
    const script = generateUniversalScript(agentId, context || undefined);
    res.json({ 
      agent_id: agentId, 
      script, 
      has_context: context !== null 
    });
  } catch (error: any) {
    console.error('Script generation error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/v1/agent/thought', async (req, res) => {
  try {
    const { agent_id, content, session_id } = req.body;
    if (!agent_id || !content) {
      return res.status(400).json({ error: 'Missing required fields: agent_id, content' });
    }
    const logEntry = await saveJournalEntry({ agent_id, type: 'THOUGHT', content, session_id });
    res.json(logEntry);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/v1/agent/error', async (req, res) => {
  try {
    const { agent_id, content, session_id } = req.body;
    if (!agent_id || !content) {
      return res.status(400).json({ error: 'Missing required fields: agent_id, content' });
    }
    const logEntry = await saveJournalEntry({ agent_id, type: 'ERROR', content, session_id });
    res.json(logEntry);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/v1/agent/checkpoint', async (req, res) => {
  try {
    const { agent_id, content, session_id, context_snapshot } = req.body;
    if (!agent_id || !content) {
      return res.status(400).json({ error: 'Missing required fields: agent_id, content' });
    }
    const logEntry = await saveJournalEntry({ agent_id, type: 'CHECKPOINT', content, session_id, context_snapshot });
    res.json(logEntry);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/v1/agent/session/close/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const result = await closeSession(sessionId);
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/v1/agent/session/close-all/:agentId', async (req, res) => {
  try {
    const { agentId } = req.params;
    const result = await closeAgentSessions(agentId);
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/v1/agent/session/new/:agentId', async (req, res) => {
  try {
    const { agentId } = req.params;
    const sessionId = await startNewSession(agentId);
    res.json({ success: true, session_id: sessionId, agent_id: agentId });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/v1/agent/signin', async (req, res) => {
  try {
    const { agent_id } = req.body;
    if (!agent_id) {
      return res.status(400).json({ error: 'agent_id is required' });
    }
    
    const sessionId = await getOrCreateSession(agent_id);
    const contextData = await getContextForSession(sessionId);
    
    const baseUrl = process.env.REPLIT_DEV_DOMAIN 
      ? `https://${process.env.REPLIT_DEV_DOMAIN}` 
      : `http://localhost:${PORT}`;
    
    const startScript = `# Quack Agent Start Script for ${agent_id}
# Session ID: ${sessionId}

You are now connected to Quack - an agent-to-agent relay system.

## Your Inbox
Your inbox is: ${agent_id}
API endpoint: ${baseUrl}/api/inbox/${agent_id}

## Step 1: Check for Messages
curl "${baseUrl}/api/inbox/${agent_id}"

## Step 2: Send a Message to Another Agent
curl -X POST "${baseUrl}/api/send" \\
  -H "Content-Type: application/json" \\
  -d '{"to": "recipient/inbox", "from": "${agent_id}", "task": "Your message here"}'

## Step 3: Record Your Progress (Context Recovery)
curl -X POST "${baseUrl}/api/v1/agent/record" \\
  -H "Content-Type: application/json" \\
  -d '{"session_id": "${sessionId}", "entry_type": "progress", "content": "Current task status..."}'

## Step 4: Get Your Context Back (if session resets)
curl "${baseUrl}/api/v1/agent/context/${sessionId}"

## Step 5: CONTINUOUS MONITORING (Keep Listening!)
Poll your inbox every 30 seconds to stay responsive to new messages:

\`\`\`javascript
async function pollQuackInbox() {
  const INBOX_URL = "${baseUrl}/api/inbox/${agent_id}";
  const POLL_INTERVAL = 30000; // 30 seconds
  
  console.log("🦆 Starting Quack inbox monitor for ${agent_id}...");
  
  while (true) {
    try {
      const response = await fetch(INBOX_URL);
      const data = await response.json();
      
      if (data.count > 0) {
        console.log(\`🦆 QUACK! \${data.count} message(s) in inbox!\`);
        for (const msg of data.messages) {
          if (msg.status === 'pending' || msg.status === 'approved') {
            console.log(\`  From: \${msg.from}\`);
            console.log(\`  Task: \${msg.task}\`);
            // Process the message here
          }
        }
      }
    } catch (error) {
      console.error("Polling error:", error);
    }
    
    await new Promise(r => setTimeout(r, POLL_INTERVAL));
  }
}

pollQuackInbox();
\`\`\`

Alternative: Check inbox periodically during your work and respond to any new messages.

${contextData.injection_prompt ? `\n## Previous Context\n${contextData.injection_prompt}` : ''}
`;

    res.json({ 
      success: true, 
      session_id: sessionId, 
      agent_id,
      start_script: startScript,
      inbox: agent_id,
      api_base: baseUrl
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/v1/agent/sessions', async (req, res) => {
  try {
    const result = await contextPool.query(`
      SELECT session_id, agent_id, created_at, last_activity, entry_count, is_active
      FROM context_sessions
      ORDER BY last_activity DESC
      LIMIT 50
    `);
    
    const activeCount = result.rows.filter((r: any) => r.is_active).length;
    const totalEntries = result.rows.reduce((sum: number, r: any) => sum + (r.entry_count || 0), 0);
    
    res.json({
      sessions: result.rows,
      active_count: activeCount,
      total_entries: totalEntries
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message, sessions: [], active_count: 0, total_entries: 0 });
  }
});

// ============== UI Routes ==============

app.get('/', (req, res) => {
  res.sendFile('index.html', { root: 'public' });
});

app.get('/setup', (req, res) => {
  res.sendFile('setup.html', { root: 'public' });
});

// ============== Start Server ==============

// Create HTTP server for WebSocket support
const server = createServer(app);

// Initialize Quack Bridge WebSocket server
const bridge = new QuackBridge(server);

// Add Bridge REST routes
app.use('/bridge', bridge.getRestRoutes());

// Export bridge for use in other modules
export { bridge };

server.listen(PORT, () => {
  console.log(`
🦆 Quack Server running on port ${PORT}
   
   REST API:
   - POST /api/send         - Send a message
   - GET  /api/inbox/:name  - Check an inbox (supports paths: /claude/project-alpha)
   - POST /api/receive/:id  - Mark message as read
   - POST /api/complete/:id - Mark message as completed
   - POST /api/approve/:id  - Approve message (for Orchestrate)
   - POST /api/status/:id   - Update message status
   
   Files:
   - POST /api/files        - Upload a file
   - GET  /api/files/:id    - Get file content
   
   Webhooks:
   - POST /api/webhooks     - Register a webhook
   - GET  /api/webhooks     - List webhooks
   - DELETE /api/webhooks/:id - Remove webhook
   
   MCP (for Claude Desktop):
   - GET  /api/mcp/sse      - SSE endpoint
   - POST /api/mcp/message  - Message handler
   
   Dispatcher (auto-trigger webhooks):
   - POST /api/task         - Receive dispatched task
   - GET  /api/dispatcher/status  - Check dispatcher status
   - POST /api/dispatcher/webhook - Register dispatcher webhook
   
   Bridge (Real-time WebSocket):
   - WSS  /bridge/connect   - WebSocket endpoint
   - GET  /bridge/agents    - List connected agents
   - GET  /bridge/status    - Bridge status
   - POST /bridge/send      - Send via WebSocket or inbox
   
   Dashboard:
   - http://localhost:${PORT}
  `);
});

export default app;
