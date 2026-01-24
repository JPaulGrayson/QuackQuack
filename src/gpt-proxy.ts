/**
 * GPT Proxy - Allows ChatGPT to participate in Quack
 * Monitors gpt/* inboxes and responds using OpenAI API
 */

import OpenAI from 'openai';
import { checkInbox, sendMessage, updateMessageStatus } from './store.js';
import { QuackMessage } from './types.js';

const openai = new OpenAI({
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
});

const GPT_INBOX = 'gpt/main';
let isProcessing = false;
let pollingInterval: NodeJS.Timeout | null = null;

interface GptProxyConfig {
  model?: string;
  systemPrompt?: string;
  pollIntervalMs?: number;
}

const defaultConfig: GptProxyConfig = {
  model: 'gpt-4o',
  systemPrompt: `You are GPT, an AI assistant participating in the Quack agent-to-agent messaging system. 
You receive messages from other AI agents (Claude, Replit, Cursor, etc.) and respond helpfully.
Keep responses concise and focused on the task at hand.
If you receive a task, acknowledge it and provide your response or solution.`,
  pollIntervalMs: 10000,
};

export async function processGptInbox(config: GptProxyConfig = {}): Promise<{ processed: number; errors: number }> {
  if (isProcessing) {
    return { processed: 0, errors: 0 };
  }

  isProcessing = true;
  const cfg = { ...defaultConfig, ...config };
  let processed = 0;
  let errors = 0;

  try {
    const messages: QuackMessage[] = checkInbox(GPT_INBOX);
    const approvedMessages = messages.filter((m: QuackMessage) => m.status === 'approved');

    for (const message of approvedMessages) {
      try {
        console.log(`[GPT Proxy] Processing message ${message.id} from ${message.from}`);
        
        updateMessageStatus(message.id, 'in_progress');

        const response = await openai.chat.completions.create({
          model: cfg.model!,
          messages: [
            { role: 'system', content: cfg.systemPrompt! },
            { role: 'user', content: `From: ${message.from}\nTask: ${message.task}\n\nContext: ${message.context || 'None provided'}` },
          ],
          max_tokens: 2048,
        });

        const gptResponse = response.choices[0]?.message?.content || 'No response generated';

        sendMessage({
          from: GPT_INBOX,
          to: message.from,
          task: `Re: ${message.task}`,
          context: gptResponse,
          replyTo: message.id,
          threadId: message.threadId || message.id,
        }, GPT_INBOX);

        updateMessageStatus(message.id, 'completed');
        processed++;
        console.log(`[GPT Proxy] Responded to ${message.from}`);
      } catch (err) {
        console.error(`[GPT Proxy] Error processing message ${message.id}:`, err);
        updateMessageStatus(message.id, 'failed');
        errors++;
      }
    }
  } finally {
    isProcessing = false;
  }

  return { processed, errors };
}

export function startGptProxy(config: GptProxyConfig = {}): void {
  const cfg = { ...defaultConfig, ...config };
  
  if (pollingInterval) {
    console.log('[GPT Proxy] Already running');
    return;
  }

  console.log(`[GPT Proxy] Starting with ${cfg.pollIntervalMs}ms polling interval`);
  
  processGptInbox(config);
  
  pollingInterval = setInterval(() => {
    processGptInbox(config);
  }, cfg.pollIntervalMs);
}

export function stopGptProxy(): void {
  if (pollingInterval) {
    clearInterval(pollingInterval);
    pollingInterval = null;
    console.log('[GPT Proxy] Stopped');
  }
}

export function getGptProxyStatus(): { running: boolean; inbox: string } {
  return {
    running: pollingInterval !== null,
    inbox: GPT_INBOX,
  };
}
