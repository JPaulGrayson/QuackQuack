/**
 * Session Registry API Endpoints
 * Add these to server.ts
 * 
 * INTEGRATION INSTRUCTIONS:
 * 
 * 1. Add to imports at top of server.ts:
 *    import {
 *      initSessionRegistry,
 *      createSession,
 *      getSession,
 *      getSessionByThreadId,
 *      listSessions,
 *      getSessionsForAgent,
 *      getSessionStats,
 *      updateSessionStatus,
 *      recordSessionMessage,
 *      endSession,
 *      generateSessionKey,
 *    } from './session-registry.js';
 * 
 * 2. Add to initialization section (after initCoWorkStore()):
 *    initSessionRegistry();
 * 
 * 3. Add these endpoints (copy the code below into server.ts)
 * 
 * 4. Update sendMessage call in POST /api/send to also create/update session
 */

// ============== SESSION API ENDPOINTS ==============
// Copy everything below into server.ts

/*

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

*/

// ============== UPDATE TO POST /api/send ==============
// Add this code INSIDE the existing POST /api/send handler,
// AFTER the message is created but BEFORE returning the response:

/*

    // Create or update session for this message thread
    const sessionKey = generateSessionKey(message.from, message.to, message.threadId);
    const session = createSession(message.from, message.to, message.threadId, {
      tags: message.tags,
    });
    
    // Record this message in the session
    recordSessionMessage(
      sessionKey, 
      message.from, 
      message.isControlMessage || false,
      message.controlType
    );

*/
