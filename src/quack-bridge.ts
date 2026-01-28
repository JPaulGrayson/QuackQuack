import { WebSocketServer, WebSocket } from 'ws';
import { Router, Request, Response } from 'express';
import { Server } from 'http';
import { sendMessage, validateInboxPath, approveMessage } from './store.js';
import { logAudit } from './db.js';
import crypto from 'crypto';

const BRIDGE_SECRET = process.env.BRIDGE_SECRET || '';
const ALLOW_DEV_BYPASS = process.env.BRIDGE_DEV_BYPASS === 'true';

interface AgentInfo {
  capabilities: string[];
  connectedAt: string;
  lastSeen: string;
}

interface ExtendedWebSocket extends WebSocket {
  isAuthenticated?: boolean;
  agentId?: string | null;
  capabilities?: string[];
  subscribedTo?: Set<string>;
}

interface BridgeMessage {
  type: string;
  [key: string]: any;
}

export class QuackBridge {
  private connections: Map<string, ExtendedWebSocket> = new Map();
  private agentInfo: Map<string, AgentInfo> = new Map();
  private wss: WebSocketServer;

  constructor(server: Server) {
    this.wss = new WebSocketServer({ 
      server,
      path: '/bridge/connect'
    });
    
    this.setupWebSocketServer();
    this.startHeartbeatCheck();
    
    console.log('[Bridge] Quack Bridge initialized on /bridge/connect');
  }

  private setupWebSocketServer(): void {
    this.wss.on('connection', (ws: ExtendedWebSocket, req) => {
      console.log('[Bridge] New connection attempt');
      
      ws.isAuthenticated = false;
      ws.agentId = null;
      
      ws.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString());
          this.handleMessage(ws, message);
        } catch (err) {
          this.sendError(ws, 'Invalid JSON message');
        }
      });
      
      ws.on('close', () => {
        if (ws.agentId) {
          console.log(`[Bridge] Agent disconnected: ${ws.agentId}`);
          this.connections.delete(ws.agentId);
          this.broadcastPresence(ws.agentId, 'offline');
        }
      });
      
      ws.on('error', (err) => {
        console.error(`[Bridge] WebSocket error:`, err.message);
      });
      
      this.send(ws, {
        type: 'welcome',
        message: 'Connected to Quack Bridge. Please authenticate.',
        protocol_version: '1.0'
      });
    });
  }

  private handleMessage(ws: ExtendedWebSocket, message: BridgeMessage): void {
    const { type } = message;
    
    if (!ws.isAuthenticated && type !== 'auth') {
      this.sendError(ws, 'Not authenticated. Send auth message first.');
      return;
    }
    
    switch (type) {
      case 'auth':
        this.handleAuth(ws, message);
        break;
      case 'ping':
        this.handlePing(ws, message);
        break;
      case 'message':
        this.handleAgentMessage(ws, message);
        break;
      case 'command':
        this.handleCommand(ws, message);
        break;
      case 'response':
        this.handleResponse(ws, message);
        break;
      case 'broadcast':
        this.handleBroadcast(ws, message);
        break;
      case 'list_agents':
        this.handleListAgents(ws, message);
        break;
      case 'subscribe':
        this.handleSubscribe(ws, message);
        break;
      default:
        this.sendError(ws, `Unknown message type: ${type}`);
    }
  }

  private handleAuth(ws: ExtendedWebSocket, message: BridgeMessage): void {
    const { agent_id, capabilities = [], token } = message;
    
    if (!agent_id) {
      this.sendError(ws, 'agent_id required for authentication');
      return;
    }
    
    if (!agent_id.includes('/')) {
      this.sendError(ws, 'agent_id must be in format: platform/name');
      return;
    }
    
    if (!this.verifyToken(token, agent_id)) {
      this.sendError(ws, 'Invalid or missing authentication token');
      console.log(`[Bridge] Auth rejected for ${agent_id}: invalid token`);
      return;
    }
    
    if (this.connections.has(agent_id)) {
      const existingWs = this.connections.get(agent_id)!;
      if (existingWs.readyState === WebSocket.OPEN) {
        existingWs.close(1000, 'New connection from same agent');
      }
    }
    
    ws.isAuthenticated = true;
    ws.agentId = agent_id;
    ws.capabilities = capabilities;
    ws.subscribedTo = new Set();
    
    this.connections.set(agent_id, ws);
    this.agentInfo.set(agent_id, {
      capabilities,
      connectedAt: new Date().toISOString(),
      lastSeen: new Date().toISOString()
    });
    
    console.log(`[Bridge] Agent authenticated: ${agent_id}`);
    
    this.send(ws, {
      type: 'auth_success',
      agent_id,
      message: `Welcome ${agent_id}!`,
      online_agents: this.getOnlineAgentCount()
    });
    
    this.broadcastPresence(agent_id, 'online');
  }

  private verifyToken(token: string | undefined, agentId: string): boolean {
    if (ALLOW_DEV_BYPASS) {
      console.log(`[Bridge] Dev bypass enabled: allowing connection for ${agentId}`);
      return true;
    }
    
    if (!BRIDGE_SECRET) {
      console.error(`[Bridge] CRITICAL: BRIDGE_SECRET not configured. Set BRIDGE_SECRET or BRIDGE_DEV_BYPASS=true`);
      return false;
    }
    
    if (!token) {
      console.log(`[Bridge] Auth failed: no token provided for ${agentId}`);
      return false;
    }
    
    const expectedToken = crypto
      .createHmac('sha256', BRIDGE_SECRET)
      .update(agentId)
      .digest('hex')
      .slice(0, 32);
    
    if (token === expectedToken) {
      return true;
    }
    
    console.log(`[Bridge] Auth failed: invalid token for ${agentId}`);
    return false;
  }

  static generateToken(agentId: string, secret: string): string {
    return crypto
      .createHmac('sha256', secret)
      .update(agentId)
      .digest('hex')
      .slice(0, 32);
  }

  private handlePing(ws: ExtendedWebSocket, message: BridgeMessage): void {
    if (ws.agentId && this.agentInfo.has(ws.agentId)) {
      this.agentInfo.get(ws.agentId)!.lastSeen = new Date().toISOString();
    }
    this.send(ws, { type: 'pong', timestamp: new Date().toISOString() });
  }

  private handleAgentMessage(ws: ExtendedWebSocket, message: BridgeMessage): void {
    const { to, content, metadata = {} } = message;
    
    if (!to || !content) {
      this.sendError(ws, 'message requires "to" and "content" fields');
      return;
    }
    
    const payload = {
      type: 'message',
      from: ws.agentId,
      to,
      content,
      metadata,
      timestamp: new Date().toISOString(),
      message_id: this.generateId()
    };
    
    if (this.connections.has(to)) {
      const targetWs = this.connections.get(to)!;
      if (targetWs.readyState === WebSocket.OPEN) {
        this.send(targetWs, payload);
        this.send(ws, { type: 'message_sent', message_id: payload.message_id, delivered: true });
        return;
      }
    }
    
    this.queueToInbox(payload);
    this.send(ws, { type: 'message_sent', message_id: payload.message_id, delivered: false, note: 'Queued to inbox' });
  }

  private handleCommand(ws: ExtendedWebSocket, message: BridgeMessage): void {
    const { to, action, payload = {}, await_response = false } = message;
    
    if (!to || !action) {
      this.sendError(ws, 'command requires "to" and "action" fields');
      return;
    }
    
    const commandId = this.generateId();
    
    const commandPayload = {
      type: 'command',
      command_id: commandId,
      from: ws.agentId,
      to,
      action,
      payload,
      await_response,
      timestamp: new Date().toISOString()
    };
    
    if (!this.connections.has(to)) {
      this.send(ws, { type: 'command_failed', command_id: commandId, error: `Agent ${to} is not online` });
      return;
    }
    
    const targetWs = this.connections.get(to)!;
    if (targetWs.readyState !== WebSocket.OPEN) {
      this.send(ws, { type: 'command_failed', command_id: commandId, error: `Agent ${to} connection not open` });
      return;
    }
    
    this.send(targetWs, commandPayload);
    this.send(ws, { type: 'command_sent', command_id: commandId, to, action });
  }

  private handleResponse(ws: ExtendedWebSocket, message: BridgeMessage): void {
    const { command_id, to, result, error } = message;
    
    if (!command_id || !to) {
      this.sendError(ws, 'response requires "command_id" and "to" fields');
      return;
    }
    
    const responsePayload = {
      type: 'response',
      command_id,
      from: ws.agentId,
      result,
      error,
      timestamp: new Date().toISOString()
    };
    
    if (this.connections.has(to)) {
      const targetWs = this.connections.get(to)!;
      if (targetWs.readyState === WebSocket.OPEN) {
        this.send(targetWs, responsePayload);
        return;
      }
    }
    
    this.send(ws, { type: 'response_failed', command_id, error: `Agent ${to} is offline` });
  }

  private handleBroadcast(ws: ExtendedWebSocket, message: BridgeMessage): void {
    const { channel, content } = message;
    
    if (!channel || !content) {
      this.sendError(ws, 'broadcast requires "channel" and "content" fields');
      return;
    }
    
    const payload = {
      type: 'broadcast',
      channel,
      from: ws.agentId,
      content,
      timestamp: new Date().toISOString()
    };
    
    let deliveredCount = 0;
    for (const [agentId, agentWs] of this.connections) {
      if (agentWs.subscribedTo && agentWs.subscribedTo.has(channel)) {
        if (agentWs.readyState === WebSocket.OPEN) {
          this.send(agentWs, payload);
          deliveredCount++;
        }
      }
    }
    
    this.send(ws, { type: 'broadcast_sent', channel, delivered_to: deliveredCount });
  }

  private handleSubscribe(ws: ExtendedWebSocket, message: BridgeMessage): void {
    const { channels = [] } = message;
    if (!ws.subscribedTo) ws.subscribedTo = new Set();
    for (const channel of channels) {
      ws.subscribedTo.add(channel);
    }
    this.send(ws, { type: 'subscribed', channels: Array.from(ws.subscribedTo) });
  }

  private handleListAgents(ws: ExtendedWebSocket, message: BridgeMessage): void {
    const { filter } = message;
    const agents: any[] = [];
    
    for (const [agentId, info] of this.agentInfo) {
      const isOnline = this.connections.has(agentId) && 
                       this.connections.get(agentId)!.readyState === WebSocket.OPEN;
      
      if (filter) {
        if (filter.online !== undefined && filter.online !== isOnline) continue;
        if (filter.platform && !agentId.startsWith(filter.platform + '/')) continue;
        if (filter.capability && !info.capabilities.includes(filter.capability)) continue;
      }
      
      agents.push({ agent_id: agentId, online: isOnline, capabilities: info.capabilities });
    }
    
    this.send(ws, { type: 'agent_list', agents, total: agents.length });
  }

  private send(ws: ExtendedWebSocket, data: any): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    }
  }

  private sendError(ws: ExtendedWebSocket, error: string): void {
    this.send(ws, { type: 'error', error, timestamp: new Date().toISOString() });
  }

  private broadcastPresence(agentId: string, status: string): void {
    const payload = { type: 'presence', agent_id: agentId, status, timestamp: new Date().toISOString() };
    for (const [id, ws] of this.connections) {
      if (id !== agentId && ws.readyState === WebSocket.OPEN) {
        this.send(ws, payload);
      }
    }
  }

  private async queueToInbox(message: any): Promise<void> {
    console.log(`[Bridge] Queuing to inbox: ${message.to}`);
    
    try {
      const to = message.to?.replace(/^\/+/, '') || '';
      const from = message.from || 'bridge/unknown';
      const task = typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
      
      const pathValidation = validateInboxPath(to, true);
      if (!pathValidation.valid) {
        console.error(`[Bridge] Invalid inbox path: ${to} - ${pathValidation.error}`);
        return;
      }
      
      const CONVERSATIONAL_AGENTS = ['claude', 'gpt', 'gemini', 'grok', 'copilot'];
      let targetInbox = to;
      const rootAgent = to.split('/')[0].toLowerCase();
      
      if (CONVERSATIONAL_AGENTS.includes(rootAgent) && to.includes('/')) {
        targetInbox = rootAgent;
      }
      
      const sentMessage = sendMessage({
        to: targetInbox,
        from: from,
        task: task,
        context: message.metadata || {},
        tags: ['bridge', 'websocket', 'auto-approved'],
        project: message.metadata?.project || 'bridge'
      }, from);
      
      approveMessage(sentMessage.id);
      
      try {
        await logAudit(
          'message.approve',
          from,
          'message',
          sentMessage.id,
          {
            reason: 'Auto-approved: authenticated bridge agent',
            source: 'quack-bridge',
            targetInbox
          }
        );
      } catch (auditErr) {
        console.error('[Bridge] Audit log failed:', auditErr);
      }
      
      console.log(`[Bridge] Message queued and auto-approved: ${sentMessage.id} -> ${targetInbox}`);
    } catch (err) {
      console.error('[Bridge] Failed to queue message to inbox:', err);
    }
  }

  private getOnlineAgentCount(): number {
    let count = 0;
    for (const ws of this.connections.values()) {
      if (ws.readyState === WebSocket.OPEN) count++;
    }
    return count;
  }

  private generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  private startHeartbeatCheck(): void {
    setInterval(() => {
      for (const [agentId, ws] of this.connections) {
        if (ws.readyState !== WebSocket.OPEN) {
          this.connections.delete(agentId);
          this.broadcastPresence(agentId, 'offline');
        }
      }
    }, 30000);
  }

  getRestRoutes(): Router {
    const router = Router();
    
    router.get('/agents', (req: Request, res: Response) => {
      const agents: any[] = [];
      for (const [agentId, info] of this.agentInfo) {
        const isOnline = this.connections.has(agentId) && 
                         this.connections.get(agentId)!.readyState === WebSocket.OPEN;
        agents.push({ agent_id: agentId, online: isOnline, capabilities: info.capabilities });
      }
      res.json({ agents, online_count: this.getOnlineAgentCount() });
    });
    
    router.get('/agents/:platform/:name', (req: Request, res: Response) => {
      const agentId = `${req.params.platform}/${req.params.name}`;
      const info = this.agentInfo.get(agentId);
      if (!info) return res.status(404).json({ error: 'Agent not found' });
      
      const isOnline = this.connections.has(agentId) && 
                       this.connections.get(agentId)!.readyState === WebSocket.OPEN;
      res.json({ agent_id: agentId, online: isOnline, ...info });
    });
    
    router.post('/send', (req: Request, res: Response) => {
      const { from, to, content } = req.body;
      if (!from || !to || !content) {
        return res.status(400).json({ error: 'from, to, and content required' });
      }
      
      const payload = {
        type: 'message',
        from, to, content,
        timestamp: new Date().toISOString(),
        message_id: this.generateId()
      };
      
      if (this.connections.has(to)) {
        const ws = this.connections.get(to)!;
        if (ws.readyState === WebSocket.OPEN) {
          this.send(ws, payload);
          return res.json({ success: true, message_id: payload.message_id, delivered: true });
        }
      }
      
      this.queueToInbox(payload);
      res.json({ success: true, message_id: payload.message_id, delivered: false, method: 'inbox' });
    });
    
    router.get('/status', (req: Request, res: Response) => {
      res.json({
        online_agents: this.getOnlineAgentCount(),
        total_known_agents: this.agentInfo.size,
        websocket_path: '/bridge/connect'
      });
    });
    
    router.get('/relay', async (req: Request, res: Response) => {
      const { from, to, task, context, project, priority, replyTo } = req.query;
      
      if (!from || !to || !task) {
        return res.status(400).json({
          error: 'Missing required query params: from, to, task',
          usage: '/bridge/relay?from=grok/main&to=claude/web&task=Hello%20Claude',
          hint: 'URL-encode special characters in task and context'
        });
      }
      
      const pathValidation = validateInboxPath(to as string, true);
      if (!pathValidation.valid) {
        return res.status(400).json({ error: pathValidation.error });
      }
      
      try {
        const message = sendMessage({
          to: to as string,
          from: from as string,
          task: decodeURIComponent(task as string),
          context: context ? decodeURIComponent(context as string) : undefined,
          project: project as string,
          priority: priority as 'low' | 'normal' | 'high' | 'urgent',
          replyTo: replyTo as string,
        }, from as string);
        
        approveMessage(message.id);
        
        try {
          await logAudit(
            'message.approve',
            from as string,
            'message',
            message.id,
            {
              reason: 'Auto-approved: GET relay for GET-only agents',
              source: 'bridge-relay',
              to: to as string
            }
          );
        } catch (auditErr) {
          console.error('[Bridge] Relay audit log failed:', auditErr);
        }
        
        console.log(`[Bridge] GET relay: ${from} -> ${to} (${message.id})`);
        
        res.json({
          success: true,
          message_id: message.id,
          from: message.from,
          to: message.to,
          status: message.status,
          hint: 'Message sent and auto-approved via GET relay'
        });
      } catch (err) {
        console.error('[Bridge] Relay error:', err);
        res.status(500).json({ error: 'Failed to send message via relay' });
      }
    });
    
    return router;
  }

  notifyAgent(agentId: string, message: any): boolean {
    if (this.connections.has(agentId)) {
      const ws = this.connections.get(agentId)!;
      if (ws.readyState === WebSocket.OPEN) {
        this.send(ws, { type: 'notification', ...message });
        return true;
      }
    }
    return false;
  }
}
