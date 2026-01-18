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
  getMessage,
  deleteMessage,
  getAllInboxes,
  getStats 
} from './store.js';
import { SendMessageRequest } from './types.js';
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

// ============== REST API ==============

// Send a message
app.post('/api/send', (req, res) => {
  try {
    const request: SendMessageRequest = req.body;
    
    if (!request.to || !request.task) {
      return res.status(400).json({ error: 'Missing required fields: to, task' });
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

// Check inbox
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

  const prompts: Record<string, string> = {
    'quack1': 'single duck quack, cute cartoon duck sound effect, short and cheerful',
    'quack2': 'two duck quacks in sequence, cute cartoon duck sounds, cheerful',
    'quack3': 'three duck quacks in quick succession, cute cartoon duck chorus, playful',
    'sad1': 'single sad duck quack, disappointed duck sound, lower pitch, melancholy',
    'sad2': 'two sad duck quacks, disappointed duck sounds, slower and lower pitch',
  };

  const prompt = prompts[type] || prompts['quack1'];

  try {
    console.log(`Generating duck sound: ${type}...`);
    const audio = await elevenlabs.textToSoundEffects.convert({
      text: prompt,
      durationSeconds: type.includes('3') ? 2 : (type.includes('2') ? 1.5 : 1),
      promptInfluence: 0.5,
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
  const validTypes = ['quack1', 'quack2', 'quack3', 'sad1', 'sad2'];
  
  if (!validTypes.includes(type)) {
    return res.status(400).json({ error: 'Invalid sound type' });
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
  
  const types = ['quack1', 'quack2', 'quack3', 'sad1', 'sad2'];
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
   - GET  /api/inbox/:name  - Check an inbox
   - POST /api/receive/:id  - Mark message as read
   - POST /api/complete/:id - Mark message as completed
   
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
   
   Dashboard:
   - http://localhost:${PORT}
  `);
});

export default app;
