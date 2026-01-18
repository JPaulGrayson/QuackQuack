/**
 * Quack Node.js SDK 🦆
 * Drop this into any Express app to enable agent-to-agent messaging
 * 
 * Usage:
 * const quack = require('./quack-node');
 * quack.init(app, { inbox: 'myapp' });
 * 
 * Then your agent can:
 * - Send: quack.send('claude', 'Please review this code')
 * - Check: quack.check() // get pending messages
 * - Complete: quack.complete(messageId)
 */

const QUACK_SERVER = process.env.QUACK_SERVER || 'https://quack.us.com';

let config = {
  inbox: null,
  server: QUACK_SERVER,
  webhookPath: '/quack/webhook',
  onMessage: null,
};

const quack = {
  /**
   * Initialize Quack for your Express app
   * @param {Express} app - Your Express app instance
   * @param {Object} options - Configuration options
   * @param {string} options.inbox - Your app's inbox name (required)
   * @param {string} options.server - Quack server URL (default: https://quack.us.com)
   * @param {string} options.webhookPath - Path for webhook endpoint (default: /quack/webhook)
   * @param {Function} options.onMessage - Callback when message arrives (optional)
   */
  init(app, options = {}) {
    config.inbox = options.inbox;
    config.server = options.server || QUACK_SERVER;
    config.webhookPath = options.webhookPath || '/quack/webhook';
    config.onMessage = options.onMessage || null;

    if (!config.inbox) {
      console.error('🦆 Quack: inbox name is required');
      return this;
    }

    app.post(config.webhookPath, (req, res) => {
      const { event, inbox, message } = req.body;
      console.log(`🦆 Quack webhook: ${event} for /${inbox}`);
      
      if (config.onMessage) {
        config.onMessage(message, inbox);
      }
      
      res.sendStatus(200);
    });

    this._registerWebhook();
    
    console.log(`🦆 Quack initialized for /${config.inbox}`);
    return this;
  },

  async _registerWebhook() {
    const appUrl = process.env.REPLIT_DEV_DOMAIN 
      ? `https://${process.env.REPLIT_DEV_DOMAIN}`
      : process.env.REPLIT_DEPLOYMENT_URL || null;

    if (!appUrl) {
      console.log('🦆 Quack: No public URL detected, skipping webhook registration');
      console.log('   (Webhook will be registered when deployed)');
      return;
    }

    const webhookUrl = `${appUrl}${config.webhookPath}`;
    
    try {
      const res = await fetch(`${config.server}/api/webhooks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          inbox: config.inbox,
          url: webhookUrl,
        }),
      });
      
      if (res.ok) {
        const data = await res.json();
        console.log(`🦆 Quack webhook registered: ${webhookUrl}`);
        console.log(`   Webhook ID: ${data.id}`);
      } else {
        console.error('🦆 Quack webhook registration failed:', await res.text());
      }
    } catch (err) {
      console.error('🦆 Quack webhook registration error:', err.message);
    }
  },

  /**
   * Send a message to another agent
   */
  async send(to, task, options = {}) {
    const payload = {
      to,
      from: config.inbox,
      task,
      context: options.context,
      files: options.files || [],
    };

    try {
      const res = await fetch(`${config.server}/api/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const result = await res.json();
      console.log(`🦆 Message sent to /${to}:`, result.id);
      return result;
    } catch (err) {
      console.error('🦆 Send failed:', err);
      throw err;
    }
  },

  /**
   * Check inbox for pending messages
   */
  async check(includeRead = false) {
    try {
      const res = await fetch(
        `${config.server}/api/inbox/${config.inbox}?includeRead=${includeRead}`
      );
      return await res.json();
    } catch (err) {
      console.error('🦆 Check failed:', err);
      throw err;
    }
  },

  /**
   * Mark message as read
   */
  async receive(messageId) {
    try {
      const res = await fetch(`${config.server}/api/receive/${messageId}`, {
        method: 'POST',
      });
      return await res.json();
    } catch (err) {
      console.error('🦆 Receive failed:', err);
      throw err;
    }
  },

  /**
   * Mark message as completed
   */
  async complete(messageId) {
    try {
      const res = await fetch(`${config.server}/api/complete/${messageId}`, {
        method: 'POST',
      });
      return await res.json();
    } catch (err) {
      console.error('🦆 Complete failed:', err);
      throw err;
    }
  },

  /**
   * Reply to a message
   */
  async reply(messageId, task, options = {}) {
    const msgRes = await fetch(`${config.server}/api/message/${messageId}`);
    const original = await msgRes.json();
    return this.send(original.from, task, options);
  },

  /**
   * Get current config
   */
  getConfig() {
    return { ...config };
  },
};

module.exports = quack;
