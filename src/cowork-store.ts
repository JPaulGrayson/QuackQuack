/**
 * CoWork Store
 * Agent configuration and routing management
 * JSON file persistence like the main store
 */

import fs from 'fs';
import path from 'path';
import { AgentConfig, AgentCategory, QuackMessage, CoWorkRouteAction } from './types.js';

const COWORK_FILE = './data/cowork.json';

interface CoWorkData {
  agents: Record<string, AgentConfig>;
  routedMessages: Record<string, QuackMessage>;  // messages routed through CoWork
}

let data: CoWorkData = {
  agents: {},
  routedMessages: {},
};

export function initCoWorkStore(): void {
  try {
    const dir = path.dirname(COWORK_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    
    if (fs.existsSync(COWORK_FILE)) {
      const loaded = JSON.parse(fs.readFileSync(COWORK_FILE, 'utf-8'));
      data = {
        agents: loaded.agents || {},
        routedMessages: loaded.routedMessages || {},
      };
      console.log(`🔧 CoWork: Loaded ${Object.keys(data.agents).length} agent configs`);
    } else {
      registerDefaultAgents();
    }
  } catch (err) {
    console.error('Failed to load CoWork store:', err);
    registerDefaultAgents();
  }
}

function registerDefaultAgents(): void {
  const defaults: Partial<AgentConfig>[] = [
    { name: 'claude', category: 'conversational', requiresApproval: true, platformUrl: 'https://claude.ai', notifyPrompt: 'Check your Quack inbox at /claude' },
    { name: 'gpt', category: 'conversational', requiresApproval: true, platformUrl: 'https://chat.openai.com', notifyPrompt: 'Check your Quack inbox at /gpt' },
    { name: 'gemini', category: 'conversational', requiresApproval: true, platformUrl: 'https://gemini.google.com', notifyPrompt: 'Check your Quack inbox at /gemini' },
    { name: 'grok', category: 'conversational', requiresApproval: true, platformUrl: 'https://grok.x.ai', notifyPrompt: 'Check your Quack inbox at /grok' },
    { name: 'copilot', category: 'conversational', requiresApproval: true, platformUrl: 'https://copilot.microsoft.com', notifyPrompt: 'Check your Quack inbox at /copilot' },
    { name: 'replit', category: 'autonomous', requiresApproval: false, platformUrl: 'https://replit.com', notifyPrompt: 'Check your Quack inbox' },
    { name: 'cursor', category: 'autonomous', requiresApproval: false, notifyPrompt: 'Check your Quack inbox at /cursor' },
    { name: 'antigravity', category: 'autonomous', requiresApproval: false },
  ];
  
  for (const agent of defaults) {
    data.agents[agent.name!] = {
      name: agent.name!,
      category: agent.category!,
      requiresApproval: agent.requiresApproval!,
      autoApproveOnCheck: !agent.requiresApproval,
      notifyVia: 'polling',
      platformUrl: agent.platformUrl,
      notifyPrompt: agent.notifyPrompt,
      registeredAt: new Date().toISOString(),
    };
  }
  persistCoWorkStore();
  console.log(`🔧 CoWork: Registered ${defaults.length} default agents`);
}

function persistCoWorkStore(): void {
  try {
    fs.writeFileSync(COWORK_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('Failed to persist CoWork store:', err);
  }
}

export function registerAgent(config: Partial<AgentConfig>): AgentConfig {
  const now = new Date().toISOString();
  const agent: AgentConfig = {
    name: config.name!,
    category: config.category || 'autonomous',
    requiresApproval: config.requiresApproval ?? false,
    autoApproveOnCheck: config.autoApproveOnCheck ?? true,
    notifyVia: config.notifyVia || 'polling',
    webhookUrl: config.webhookUrl,
    platformUrl: config.platformUrl,
    notifyPrompt: config.notifyPrompt,
    registeredAt: data.agents[config.name!]?.registeredAt || now,
    lastActivity: now,
  };
  
  data.agents[agent.name] = agent;
  persistCoWorkStore();
  console.log(`🔧 CoWork: Registered agent "${agent.name}" (${agent.category})`);
  return agent;
}

export function getAgent(name: string): AgentConfig | null {
  return data.agents[name] || null;
}

export function getAllAgents(): AgentConfig[] {
  return Object.values(data.agents);
}

export function updateLastActivity(name: string): void {
  const agent = data.agents[name];
  if (agent) {
    agent.lastActivity = new Date().toISOString();
    persistCoWorkStore();
  }
}

export function getAgentCategory(name: string): AgentCategory | null {
  const agent = data.agents[name];
  return agent?.category || null;
}

export function shouldAutoApprove(fromAgent: string, toAgent: string): boolean {
  const from = data.agents[fromAgent];
  const to = data.agents[toAgent];
  
  if (!from && !to) {
    return true;
  }
  
  if (to?.requiresApproval) {
    return false;
  }
  
  if (from?.category === 'conversational') {
    return false;
  }
  
  return true;
}

export function getCoWorkStats(): {
  totalAgents: number;
  conversational: number;
  autonomous: number;
  supervised: number;
  onlineAgents: number;
} {
  const agents = Object.values(data.agents);
  const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
  
  return {
    totalAgents: agents.length,
    conversational: agents.filter(a => a.category === 'conversational').length,
    autonomous: agents.filter(a => a.category === 'autonomous').length,
    supervised: agents.filter(a => a.category === 'supervised').length,
    onlineAgents: agents.filter(a => 
      a.lastActivity && new Date(a.lastActivity) > fiveMinutesAgo
    ).length,
  };
}

export function deleteAgent(name: string): boolean {
  if (data.agents[name]) {
    delete data.agents[name];
    persistCoWorkStore();
    console.log(`🔧 CoWork: Deleted agent "${name}"`);
    return true;
  }
  return false;
}

// ============== CoWork Routing ==============

export function addRoutedMessage(message: QuackMessage): void {
  data.routedMessages[message.id] = message;
  persistCoWorkStore();
  console.log(`🔧 CoWork: Routed message ${message.id} to ${message.destination}`);
}

export function getRoutedMessage(id: string): QuackMessage | null {
  return data.routedMessages[id] || null;
}

export function getRoutedMessagesForAgent(destination: string): QuackMessage[] {
  return Object.values(data.routedMessages)
    .filter(m => {
      // Match exact destination or prefix (e.g., "claude" matches "claude/project")
      const destAgent = m.destination?.split('/')[0];
      return destAgent === destination || m.destination === destination;
    })
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
}

export function updateRoutedMessageStatus(
  id: string, 
  action: CoWorkRouteAction
): QuackMessage | null {
  const message = data.routedMessages[id];
  if (!message) return null;
  
  message.coworkStatus = action === 'approve' ? 'approved' 
    : action === 'reject' ? 'rejected' 
    : 'forwarded';
  
  persistCoWorkStore();
  console.log(`🔧 CoWork: Message ${id} status updated to ${message.coworkStatus}`);
  return message;
}

export function removeRoutedMessage(id: string): boolean {
  if (data.routedMessages[id]) {
    delete data.routedMessages[id];
    persistCoWorkStore();
    return true;
  }
  return false;
}

export function getAllRoutedMessages(): QuackMessage[] {
  return Object.values(data.routedMessages);
}
