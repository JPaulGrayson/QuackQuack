/**
 * @quack/core - Express Router Factory
 * Creates an Express router with all Quack API routes
 */

import { Router, Request, Response } from 'express';
import { 
  QuackStore 
} from '../store/index.js';
import { 
  VALID_STATUSES, 
  STATUS_TRANSITIONS,
  MessageStatus 
} from '../types/index.js';

export interface QuackRouterOptions {
  store: QuackStore;
}

export function createQuackRouter(options: QuackRouterOptions): Router {
  const { store } = options;
  const router = Router();

  router.post('/send', async (req: Request, res: Response) => {
    try {
      const { to, from, task, context, files, fileRefs, projectName, conversationExcerpt, replyTo } = req.body;
      
      if (!to || !task) {
        return res.status(400).json({ error: 'Missing required fields: to, task' });
      }
      
      const message = await store.sendMessage({
        to, from, task, context, files, fileRefs, projectName, conversationExcerpt, replyTo
      }, from || 'unknown');
      
      res.json({ success: true, messageId: message.id, message });
    } catch (err: any) {
      console.error('Send error:', err);
      res.status(500).json({ error: 'Failed to send message' });
    }
  });

  router.get('/inbox/:name', async (req: Request, res: Response) => {
    const inbox = req.params.name;
    const includeRead = req.query.includeRead === 'true';
    const messages = await store.checkInbox(inbox, includeRead);
    res.json({ inbox, messages, count: messages.length });
  });

  router.get('/inbox/:parent/:child', async (req: Request, res: Response) => {
    const inbox = `${req.params.parent}/${req.params.child}`;
    const includeRead = req.query.includeRead === 'true';
    const messages = await store.checkInbox(inbox, includeRead);
    res.json({ inbox, messages, count: messages.length });
  });

  router.get('/inbox/:parent/:child/:subchild', async (req: Request, res: Response) => {
    const inbox = `${req.params.parent}/${req.params.child}/${req.params.subchild}`;
    const includeRead = req.query.includeRead === 'true';
    const messages = await store.checkInbox(inbox, includeRead);
    res.json({ inbox, messages, count: messages.length });
  });

  router.get('/message/:id', async (req: Request, res: Response) => {
    const message = await store.getMessage(req.params.id);
    if (!message) {
      return res.status(404).json({ error: 'Message not found' });
    }
    res.json(message);
  });

  router.post('/receive/:id', async (req: Request, res: Response) => {
    const message = await store.receiveMessage(req.params.id);
    if (!message) {
      return res.status(404).json({ error: 'Message not found' });
    }
    res.json({ success: true, message });
  });

  router.post('/complete/:id', async (req: Request, res: Response) => {
    const message = await store.completeMessage(req.params.id);
    if (!message) {
      return res.status(404).json({ error: 'Message not found' });
    }
    res.json({ success: true, message });
  });

  router.post('/approve/:id', async (req: Request, res: Response) => {
    const message = await store.approveMessage(req.params.id);
    if (!message) {
      return res.status(404).json({ error: 'Message not found or cannot be approved' });
    }
    res.json({ success: true, message });
  });

  router.post('/status/:id', async (req: Request, res: Response) => {
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
    
    const existingMessage = await store.getMessage(req.params.id);
    if (!existingMessage) {
      return res.status(404).json({ success: false, error: 'Message not found' });
    }
    
    const allowedTransitions = STATUS_TRANSITIONS[existingMessage.status] || [];
    if (!allowedTransitions.includes(status)) {
      return res.status(400).json({ 
        success: false, 
        error: `Cannot transition from '${existingMessage.status}' to '${status}'. Allowed: ${allowedTransitions.join(', ') || 'none'}` 
      });
    }
    
    const message = await store.updateMessageStatus(req.params.id, status as MessageStatus);
    res.json({ success: true, message });
  });

  router.delete('/message/:id', async (req: Request, res: Response) => {
    const deleted = await store.deleteMessage(req.params.id);
    if (!deleted) {
      return res.status(404).json({ success: false, error: 'Message not found' });
    }
    res.json({ success: true });
  });

  router.get('/inboxes', async (_req: Request, res: Response) => {
    const inboxes = await store.getAllInboxes();
    res.json({ inboxes });
  });

  router.get('/stats', async (_req: Request, res: Response) => {
    const stats = await store.getStats();
    res.json(stats);
  });

  return router;
}
