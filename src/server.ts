/**
 * Quack Server
 * 🦆 Agent-to-agent relay for vibe coders
 * 
 * Endpoints:
 * - POST /api/send         - Send a message
 * - GET  /api/inbox/:name  - Check an inbox
 * - GET  /api/message/:id  - Get a specific message
 * - POST /api/receive/:id  - Mark message as read
 * - POST /api/complete/:id - Mark message as completed
 * - GET  /api/stats        - Server stats
 * - GET  /api/mcp/sse      - MCP Server-Sent Events endpoint
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
import { SendMessageRequest, MCP_TOOLS } from './types.js';
import { handleMCPConnection } from './mcp-handler.js';

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' })); // Allow larger payloads for files
app.use(express.static('public'));

// Initialize store
initStore();

// ============== REST API ==============

// Send a message
app.post('/api/send', (req, res) => {
  try {
    const request: SendMessageRequest = req.body;
    
    if (!request.to || !request.task) {
      return res.status(400).json({ error: 'Missing required fields: to, task' });
    }
    
    const message = sendMessage(request, request.from || 'api');
    
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

// ============== MCP SSE Endpoint ==============

app.get('/api/mcp/sse', (req, res) => {
  console.log('🔌 MCP client connected');
  
  // Set up SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  // Handle MCP protocol over SSE
  handleMCPConnection(req, res);
});

// MCP POST endpoint for messages
app.post('/api/mcp/message', express.json(), (req, res) => {
  // This will be handled by the MCP handler
  res.json({ received: true });
});

// ============== UI Routes ==============

// Serve index.html for root
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
   - GET  /api/message/:id  - Get a specific message
   - POST /api/receive/:id  - Mark message as read
   - POST /api/complete/:id - Mark message as completed
   
   MCP:
   - GET  /api/mcp/sse      - MCP endpoint for Claude Desktop
   
   UI:
   - http://localhost:${PORT}
  `);
});

export default app;
