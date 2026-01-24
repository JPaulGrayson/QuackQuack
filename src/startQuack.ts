import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';

interface MonitoringSession {
  id: string;
  inbox: string;
  interval: number;
  status: 'monitoring' | 'error' | 'idle';
  lastCheck: string | null;
  pendingCount: number;
  intervalId: NodeJS.Timeout;
}

const sessions = new Map<string, MonitoringSession>();

const router = Router();

router.post('/start', async (req: Request, res: Response) => {
  const { inbox, interval = 60 } = req.body;
  
  if (!inbox) {
    return res.status(400).json({ error: 'inbox required' });
  }
  
  if (sessions.has(inbox)) {
    return res.json({ success: true, status: 'already_monitoring' });
  }
  
  const id = uuidv4();
  const session: MonitoringSession = {
    id,
    inbox,
    interval,
    status: 'monitoring',
    lastCheck: null,
    pendingCount: 0,
    intervalId: null as any
  };
  
  session.intervalId = setInterval(() => checkInbox(inbox, session), interval * 1000);
  sessions.set(inbox, session);
  
  await checkInbox(inbox, session);
  
  res.json({ success: true, monitoringId: id, status: 'monitoring' });
});

router.post('/stop', (req: Request, res: Response) => {
  const { inbox } = req.body;
  const session = sessions.get(inbox);
  
  if (!session) {
    return res.status(404).json({ error: 'not monitoring this inbox' });
  }
  
  clearInterval(session.intervalId);
  sessions.delete(inbox);
  
  res.json({ success: true, status: 'stopped' });
});

router.get('/status', (req: Request, res: Response) => {
  const { inbox } = req.query as { inbox?: string };
  const session = sessions.get(inbox || '');
  
  if (!session) {
    return res.json({ status: 'idle' });
  }
  
  res.json({
    status: session.status,
    lastCheck: session.lastCheck,
    pendingCount: session.pendingCount
  });
});

router.get('/sessions', (_req: Request, res: Response) => {
  const allSessions = Array.from(sessions.values()).map(s => ({
    id: s.id,
    inbox: s.inbox,
    interval: s.interval,
    status: s.status,
    lastCheck: s.lastCheck,
    pendingCount: s.pendingCount
  }));
  
  res.json({ sessions: allSessions, count: allSessions.length });
});

async function checkInbox(inbox: string, session: MonitoringSession): Promise<void> {
  try {
    const port = process.env.PORT || 5000;
    const response = await fetch(`http://localhost:${port}/api/inbox/${inbox}`);
    const data = await response.json() as { messages?: Array<{ status: string }> };
    
    session.lastCheck = new Date().toISOString();
    session.pendingCount = (data.messages || []).filter(m => m.status === 'pending').length;
    session.status = 'monitoring';
  } catch (e) {
    console.error(`Error checking inbox ${inbox}:`, e);
    session.status = 'error';
  }
}

export default router;
