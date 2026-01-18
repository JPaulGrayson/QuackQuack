/**
 * Quack Seed Script 🦆
 * Drop this into any app to enable agent-to-agent messaging
 * 
 * Usage:
 * <script src="https://your-quack-url/seed.js"></script>
 * <script>
 *   Quack.init({ 
 *     server: 'https://your-quack-url',
 *     inbox: 'replit'  // This agent's inbox name
 *   });
 * </script>
 */

(function() {
  const DEFAULT_SERVER = window.QUACK_SERVER || 'https://quack.us.com';
  
  const Quack = {
    server: DEFAULT_SERVER,
    inbox: null,
    
    /**
     * Initialize Quack
     */
    init(options = {}) {
      this.server = options.server || DEFAULT_SERVER;
      this.inbox = options.inbox || null;
      
      console.log('🦆 Quack initialized', { server: this.server, inbox: this.inbox });
      
      // Add keyboard shortcut (Ctrl+Shift+Q)
      if (options.enableShortcut !== false) {
        document.addEventListener('keydown', (e) => {
          if (e.ctrlKey && e.shiftKey && e.key === 'Q') {
            this.showPanel();
          }
        });
      }
      
      return this;
    },
    
    /**
     * Send a message to another agent
     */
    async send(to, task, options = {}) {
      const payload = {
        to,
        from: this.inbox || 'web',
        task,
        context: options.context,
        files: options.files || [],
        projectName: options.projectName,
        conversationExcerpt: options.conversationExcerpt,
      };
      
      try {
        const res = await fetch(`${this.server}/api/send`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        
        const result = await res.json();
        console.log('🦆 Message sent:', result);
        return result;
      } catch (err) {
        console.error('🦆 Send failed:', err);
        throw err;
      }
    },
    
    /**
     * Check inbox for messages
     */
    async check(inbox = null, includeRead = false) {
      const targetInbox = inbox || this.inbox;
      if (!targetInbox) {
        throw new Error('No inbox specified. Call init({ inbox: "name" }) or pass inbox to check()');
      }
      
      try {
        const res = await fetch(`${this.server}/api/inbox/${targetInbox}?includeRead=${includeRead}`);
        const result = await res.json();
        console.log('🦆 Inbox check:', result);
        return result;
      } catch (err) {
        console.error('🦆 Check failed:', err);
        throw err;
      }
    },
    
    /**
     * Receive (mark as read) a specific message
     */
    async receive(messageId) {
      try {
        const res = await fetch(`${this.server}/api/receive/${messageId}`, {
          method: 'POST',
        });
        const result = await res.json();
        console.log('🦆 Message received:', result);
        return result;
      } catch (err) {
        console.error('🦆 Receive failed:', err);
        throw err;
      }
    },
    
    /**
     * Mark a message as complete
     */
    async complete(messageId) {
      try {
        const res = await fetch(`${this.server}/api/complete/${messageId}`, {
          method: 'POST',
        });
        const result = await res.json();
        console.log('🦆 Message completed:', result);
        return result;
      } catch (err) {
        console.error('🦆 Complete failed:', err);
        throw err;
      }
    },
    
    /**
     * Reply to a message
     */
    async reply(messageId, task, options = {}) {
      // First get the original message
      const msgRes = await fetch(`${this.server}/api/message/${messageId}`);
      const original = await msgRes.json();
      
      return this.send(original.from, task, {
        ...options,
        replyTo: messageId,
      });
    },
    
    /**
     * Show floating panel UI
     */
    showPanel() {
      // Create panel if it doesn't exist
      let panel = document.getElementById('quack-panel');
      if (!panel) {
        panel = document.createElement('div');
        panel.id = 'quack-panel';
        panel.innerHTML = `
          <style>
            #quack-panel {
              position: fixed;
              bottom: 20px;
              right: 20px;
              width: 350px;
              max-height: 500px;
              background: #1a1a2e;
              border: 1px solid rgba(255, 193, 7, 0.3);
              border-radius: 16px;
              box-shadow: 0 10px 40px rgba(0,0,0,0.5);
              z-index: 99999;
              font-family: -apple-system, BlinkMacSystemFont, sans-serif;
              color: #e0e0e0;
              overflow: hidden;
            }
            #quack-panel-header {
              display: flex;
              justify-content: space-between;
              align-items: center;
              padding: 1rem;
              background: rgba(255, 193, 7, 0.1);
              border-bottom: 1px solid rgba(255, 193, 7, 0.2);
            }
            #quack-panel-title {
              font-weight: bold;
              color: #ffc107;
            }
            #quack-panel-close {
              background: none;
              border: none;
              color: #888;
              font-size: 1.2rem;
              cursor: pointer;
            }
            #quack-panel-content {
              padding: 1rem;
              max-height: 400px;
              overflow-y: auto;
            }
            .quack-message {
              background: rgba(255,255,255,0.05);
              border-radius: 8px;
              padding: 0.75rem;
              margin-bottom: 0.5rem;
            }
            .quack-message-from {
              color: #ffc107;
              font-size: 0.8rem;
            }
            .quack-message-task {
              margin-top: 0.25rem;
              font-size: 0.9rem;
            }
            .quack-empty {
              text-align: center;
              color: #666;
              padding: 2rem;
            }
          </style>
          <div id="quack-panel-header">
            <span id="quack-panel-title">🦆 Quack${this.inbox ? ' - /' + this.inbox : ''}</span>
            <button id="quack-panel-close">×</button>
          </div>
          <div id="quack-panel-content">
            <div class="quack-empty">Loading...</div>
          </div>
        `;
        document.body.appendChild(panel);
        
        document.getElementById('quack-panel-close').onclick = () => {
          panel.style.display = 'none';
        };
        
        this.refreshPanel();
      } else {
        panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
        if (panel.style.display === 'block') {
          this.refreshPanel();
        }
      }
    },
    
    /**
     * Refresh panel content
     */
    async refreshPanel() {
      const content = document.getElementById('quack-panel-content');
      if (!content) return;
      
      if (!this.inbox) {
        content.innerHTML = '<div class="quack-empty">No inbox configured.<br>Call Quack.init({ inbox: "name" })</div>';
        return;
      }
      
      try {
        const { messages } = await this.check(this.inbox, true);
        
        if (messages.length === 0) {
          content.innerHTML = '<div class="quack-empty">No messages</div>';
        } else {
          content.innerHTML = messages.map(m => `
            <div class="quack-message">
              <div class="quack-message-from">From: ${m.from} · ${m.status}</div>
              <div class="quack-message-task">${m.task}</div>
            </div>
          `).join('');
        }
      } catch (err) {
        content.innerHTML = `<div class="quack-empty">Error: ${err.message}</div>`;
      }
    }
  };
  
  // Expose globally
  window.Quack = Quack;
})();
