/**
 * Quack Server - Fixed for MCP compatibility
 * 🦆 Agent-to-agent relay for vibe coders
 */

import express from 'express';
import cors from 'cors';
import { 
  initStore, 
  sendMessage, 
  checkInbox, 
  receiveMessage, 
  completeMessage,
  getMessage,
  getAllInboxes,
  getStats 
} from './store.js';
import { SendMessageRequest } from './types.js';
import { handleMCPSSE, handleMCPMessage } from './mcp-handler.js';
import { initFileStore, uploadFile, getFile, getFileMeta } from './file-store.js';

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

// ============== UI Routes ==============

app.get('/', (req, res) => {
  res.sendFile('index.html', { root: 'public' });
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
   
   MCP (for Claude Desktop):
   - GET  /api/mcp/sse      - SSE endpoint
   - POST /api/mcp/message  - Message handler
   
   Dashboard:
   - http://localhost:${PORT}
  `);
});

export default app;
