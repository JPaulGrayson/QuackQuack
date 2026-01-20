/**
 * Quack Server - Fixed for MCP compatibility
 * 🦆 Agent-to-agent relay for vibe coders
 */

import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
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
import { SendMessageRequest, VALID_STATUSES, MessageStatus, QuackMessage } from './types.js';
import { QuackStore, Dispatcher } from '../packages/@quack/core/dist/index.js';
import { handleMCPSSE, handleMCPMessage } from './mcp-handler.js';
import { initFileStore, uploadFile, getFile, getFileMeta } from './file-store.js';
import { initWebhooks, registerWebhook, removeWebhook, listWebhooks, triggerWebhooks } from './webhooks.js';

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
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  }
}));

// Initialize stores
initStore();
initFileStore();
initWebhooks();

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

// ============== REST API ==============

// Send a message
app.post('/api/send', (req, res) => {
  try {
    const request: SendMessageRequest = req.body;
    
    if (!request.to || !request.task) {
      return res.status(400).json({ error: 'Missing required fields: to, task' });
    }
    
    // Validate inbox path format (must be platform/application)
    const pathValidation = validateInboxPath(request.to);
    if (!pathValidation.valid) {
      return res.status(400).json({ 
        error: pathValidation.error,
        hint: 'Use format: platform/application (e.g., "replit/orchestrate", "claude/my-project")'
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
app.get('/api/inbox/:name', (req, res) => {
  const inbox = req.params.name;
  const includeRead = req.query.includeRead === 'true';
  
  const messages = checkInbox(inbox, includeRead);
  
  res.json({
    inbox,
    messages,
    count: messages.length,
  });
});

// Check inbox - supports two-level hierarchical paths (e.g., /api/inbox/claude/project-alpha)
app.get('/api/inbox/:parent/:child', (req, res) => {
  const inbox = `${req.params.parent}/${req.params.child}`;
  const includeRead = req.query.includeRead === 'true';
  
  const messages = checkInbox(inbox, includeRead);
  
  res.json({
    inbox,
    messages,
    count: messages.length,
  });
});

// Check inbox - supports three-level hierarchical paths (e.g., /api/inbox/claude/project/subtask)
app.get('/api/inbox/:parent/:child/:subchild', (req, res) => {
  const inbox = `${req.params.parent}/${req.params.child}/${req.params.subchild}`;
  const includeRead = req.query.includeRead === 'true';
  
  const messages = checkInbox(inbox, includeRead);
  
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
  
  res.json({
    success: true,
    message,
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

// ============== UI Routes ==============

app.get('/', (req, res) => {
  res.sendFile('index.html', { root: 'public' });
});

app.get('/setup', (req, res) => {
  res.sendFile('setup.html', { root: 'public' });
});

// ============== Start Server ==============

app.listen(PORT, () => {
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
   
   Dashboard:
   - http://localhost:${PORT}
  `);
});

export default app;
