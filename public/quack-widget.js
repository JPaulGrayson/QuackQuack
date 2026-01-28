/**
 * Quack Widget - Embeddable inbox widget for AI agent messaging
 * Usage:
 *   <div id="quack-widget"></div>
 *   <script src="https://quack.us.com/quack-widget.js"></script>
 *   <script>
 *     QuackWidget.init({
 *       container: '#quack-widget',
 *       inbox: 'replit/orchestrate',
 *       pollInterval: 5000,
 *       theme: 'dark'
 *     });
 *   </script>
 */

(function(global) {
  'use strict';

  const DEFAULT_OPTIONS = {
    container: '#quack-widget',
    inbox: null,
    baseUrl: 'https://quack.us.com',
    pollInterval: 5000,
    theme: 'dark',
    showThreads: true,
    showApproveReject: true,
    onMessage: null,
    onApprove: null,
    onReject: null,
    onError: null,
    maxHeight: '500px'
  };

  const STYLES = `
    .quack-widget {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      border-radius: 12px;
      overflow: hidden;
    }
    .quack-widget.dark {
      background: #1a1a2e;
      color: #e0e0e0;
      border: 1px solid rgba(255,255,255,0.1);
    }
    .quack-widget.light {
      background: #ffffff;
      color: #333;
      border: 1px solid #e0e0e0;
    }
    .quack-header {
      padding: 1rem;
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 1px solid rgba(255,255,255,0.1);
    }
    .quack-widget.light .quack-header {
      border-bottom: 1px solid #e0e0e0;
    }
    .quack-title {
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }
    .quack-title .duck { font-size: 1.5rem; }
    .quack-widget.dark .quack-title { color: #ffc107; }
    .quack-widget.light .quack-title { color: #f59e0b; }
    .quack-badge {
      background: #ef4444;
      color: white;
      font-size: 0.75rem;
      padding: 0.2rem 0.5rem;
      border-radius: 10px;
      font-weight: bold;
    }
    .quack-tabs {
      display: flex;
      border-bottom: 1px solid rgba(255,255,255,0.1);
    }
    .quack-widget.light .quack-tabs {
      border-bottom: 1px solid #e0e0e0;
    }
    .quack-tab {
      flex: 1;
      padding: 0.75rem;
      text-align: center;
      cursor: pointer;
      transition: all 0.2s;
      border: none;
      background: none;
      color: inherit;
      font-size: 0.9rem;
    }
    .quack-tab:hover {
      background: rgba(255,255,255,0.05);
    }
    .quack-widget.light .quack-tab:hover {
      background: rgba(0,0,0,0.05);
    }
    .quack-tab.active {
      border-bottom: 2px solid #ffc107;
    }
    .quack-widget.light .quack-tab.active {
      border-bottom: 2px solid #f59e0b;
    }
    .quack-content {
      overflow-y: auto;
      padding: 0.5rem;
    }
    .quack-message {
      padding: 1rem;
      margin: 0.5rem 0;
      border-radius: 8px;
      transition: all 0.2s;
    }
    .quack-widget.dark .quack-message {
      background: rgba(255,255,255,0.03);
      border: 1px solid rgba(255,255,255,0.1);
    }
    .quack-widget.light .quack-message {
      background: #f9fafb;
      border: 1px solid #e5e7eb;
    }
    .quack-message:hover {
      transform: translateY(-1px);
    }
    .quack-widget.dark .quack-message:hover {
      border-color: rgba(255,193,7,0.5);
    }
    .quack-widget.light .quack-message:hover {
      border-color: #f59e0b;
    }
    .quack-message-header {
      display: flex;
      justify-content: space-between;
      margin-bottom: 0.5rem;
      font-size: 0.85rem;
    }
    .quack-from {
      font-weight: 600;
    }
    .quack-widget.dark .quack-from { color: #00d9ff; }
    .quack-widget.light .quack-from { color: #0ea5e9; }
    .quack-time { opacity: 0.6; }
    .quack-task {
      margin-bottom: 0.5rem;
      line-height: 1.5;
    }
    .quack-status {
      display: inline-block;
      padding: 0.2rem 0.5rem;
      border-radius: 4px;
      font-size: 0.75rem;
      font-weight: 600;
    }
    .quack-status.pending { background: rgba(245,158,11,0.2); color: #f59e0b; }
    .quack-status.approved { background: rgba(34,197,94,0.2); color: #22c55e; }
    .quack-status.in_progress { background: rgba(59,130,246,0.2); color: #3b82f6; }
    .quack-status.completed { background: rgba(34,197,94,0.2); color: #22c55e; }
    .quack-status.failed { background: rgba(239,68,68,0.2); color: #ef4444; }
    .quack-status.rejected { background: rgba(239,68,68,0.2); color: #ef4444; }
    .quack-actions {
      display: flex;
      gap: 0.5rem;
      margin-top: 0.75rem;
    }
    .quack-btn {
      padding: 0.4rem 0.8rem;
      border-radius: 6px;
      border: none;
      cursor: pointer;
      font-size: 0.85rem;
      font-weight: 500;
      transition: all 0.2s;
    }
    .quack-btn-approve {
      background: rgba(34,197,94,0.2);
      color: #22c55e;
    }
    .quack-btn-approve:hover {
      background: rgba(34,197,94,0.3);
    }
    .quack-btn-reject {
      background: rgba(239,68,68,0.2);
      color: #ef4444;
    }
    .quack-btn-reject:hover {
      background: rgba(239,68,68,0.3);
    }
    .quack-btn-view {
      background: rgba(59,130,246,0.2);
      color: #3b82f6;
    }
    .quack-btn-view:hover {
      background: rgba(59,130,246,0.3);
    }
    .quack-empty {
      text-align: center;
      padding: 2rem;
      opacity: 0.6;
    }
    .quack-empty .duck { font-size: 3rem; margin-bottom: 1rem; }
    .quack-loading {
      text-align: center;
      padding: 2rem;
    }
    .quack-spinner {
      width: 30px;
      height: 30px;
      border: 3px solid rgba(255,193,7,0.3);
      border-top-color: #ffc107;
      border-radius: 50%;
      animation: quack-spin 1s linear infinite;
      margin: 0 auto 1rem;
    }
    @keyframes quack-spin {
      to { transform: rotate(360deg); }
    }
    .quack-refresh {
      background: none;
      border: none;
      cursor: pointer;
      font-size: 1.2rem;
      opacity: 0.6;
      transition: all 0.2s;
    }
    .quack-refresh:hover {
      opacity: 1;
      transform: rotate(180deg);
    }
    .quack-thread-indicator {
      font-size: 0.75rem;
      opacity: 0.6;
      margin-top: 0.5rem;
    }
    .quack-priority {
      display: inline-block;
      padding: 0.15rem 0.4rem;
      border-radius: 4px;
      font-size: 0.7rem;
      font-weight: 600;
      margin-left: 0.5rem;
    }
    .quack-priority.high { background: rgba(245,158,11,0.2); color: #f59e0b; }
    .quack-priority.urgent { background: rgba(239,68,68,0.2); color: #ef4444; }
  `;

  class QuackWidget {
    constructor(options) {
      this.options = { ...DEFAULT_OPTIONS, ...options };
      this.messages = [];
      this.threads = {};
      this.pollTimer = null;
      this.currentView = 'inbox';
      this.init();
    }

    init() {
      this.injectStyles();
      this.container = document.querySelector(this.options.container);
      if (!this.container) {
        console.error('QuackWidget: Container not found:', this.options.container);
        return;
      }
      this.render();
      this.startPolling();
    }

    injectStyles() {
      if (document.getElementById('quack-widget-styles')) return;
      const style = document.createElement('style');
      style.id = 'quack-widget-styles';
      style.textContent = STYLES;
      document.head.appendChild(style);
    }

    render() {
      const theme = this.options.theme;
      this.container.innerHTML = `
        <div class="quack-widget ${theme}">
          <div class="quack-header">
            <div class="quack-title">
              <span class="duck">🦆</span>
              <span>Quack</span>
              <span class="quack-badge" id="quack-count" style="display:none">0</span>
            </div>
            <button class="quack-refresh" onclick="QuackWidget.instance.refresh()" title="Refresh">🔄</button>
          </div>
          ${this.options.showThreads ? `
          <div class="quack-tabs">
            <button class="quack-tab active" data-view="inbox">Inbox</button>
            <button class="quack-tab" data-view="threads">Threads</button>
          </div>
          ` : ''}
          <div class="quack-content" id="quack-content" style="max-height: ${this.options.maxHeight}">
            <div class="quack-loading">
              <div class="quack-spinner"></div>
              <div>Loading messages...</div>
            </div>
          </div>
        </div>
      `;

      if (this.options.showThreads) {
        this.container.querySelectorAll('.quack-tab').forEach(tab => {
          tab.addEventListener('click', () => this.switchView(tab.dataset.view));
        });
      }
    }

    switchView(view) {
      this.currentView = view;
      this.container.querySelectorAll('.quack-tab').forEach(tab => {
        tab.classList.toggle('active', tab.dataset.view === view);
      });
      this.renderMessages();
    }

    async fetchMessages() {
      try {
        const url = `${this.options.baseUrl}/api/inbox/${this.options.inbox}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        
        const newMessages = data.messages.filter(m => 
          !this.messages.find(existing => existing.id === m.id)
        );
        
        this.messages = data.messages;
        this.organizeThreads();
        this.updateBadge();
        this.renderMessages();

        if (newMessages.length > 0 && this.options.onMessage) {
          newMessages.forEach(msg => this.options.onMessage(msg));
        }
      } catch (err) {
        console.error('QuackWidget: Fetch error:', err);
        if (this.options.onError) this.options.onError(err);
      }
    }

    organizeThreads() {
      this.threads = {};
      this.messages.forEach(msg => {
        const threadId = msg.threadId || msg.id;
        if (!this.threads[threadId]) {
          this.threads[threadId] = [];
        }
        this.threads[threadId].push(msg);
      });
      Object.values(this.threads).forEach(thread => {
        thread.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
      });
    }

    updateBadge() {
      const pending = this.messages.filter(m => m.status === 'pending').length;
      const badge = this.container.querySelector('#quack-count');
      if (badge) {
        badge.textContent = pending;
        badge.style.display = pending > 0 ? 'inline' : 'none';
      }
    }

    renderMessages() {
      const content = this.container.querySelector('#quack-content');
      
      if (this.currentView === 'inbox') {
        this.renderInbox(content);
      } else {
        this.renderThreads(content);
      }
    }

    renderInbox(content) {
      if (this.messages.length === 0) {
        content.innerHTML = `
          <div class="quack-empty">
            <div class="duck">🦆</div>
            <div>No messages yet</div>
          </div>
        `;
        return;
      }

      const sorted = [...this.messages].sort((a, b) => 
        new Date(b.timestamp) - new Date(a.timestamp)
      );

      content.innerHTML = sorted.map(msg => this.renderMessage(msg)).join('');
      this.attachMessageHandlers(content);
    }

    renderThreads(content) {
      const threadIds = Object.keys(this.threads);
      if (threadIds.length === 0) {
        content.innerHTML = `
          <div class="quack-empty">
            <div class="duck">🦆</div>
            <div>No threads yet</div>
          </div>
        `;
        return;
      }

      const sortedThreads = threadIds
        .map(id => ({
          id,
          messages: this.threads[id],
          latest: this.threads[id][this.threads[id].length - 1]
        }))
        .sort((a, b) => new Date(b.latest.timestamp) - new Date(a.latest.timestamp));

      content.innerHTML = sortedThreads.map(thread => `
        <div class="quack-message" data-thread-id="${thread.id}">
          <div class="quack-message-header">
            <span class="quack-from">${this.escapeHtml(thread.latest.from)}</span>
            <span class="quack-time">${this.formatTime(thread.latest.timestamp)}</span>
          </div>
          <div class="quack-task">${this.escapeHtml(thread.latest.task)}</div>
          <div class="quack-thread-indicator">
            💬 ${thread.messages.length} message${thread.messages.length > 1 ? 's' : ''} in thread
          </div>
        </div>
      `).join('');
    }

    renderMessage(msg) {
      const showActions = this.options.showApproveReject && msg.status === 'pending';
      const priorityBadge = msg.priority && ['high', 'urgent'].includes(msg.priority)
        ? `<span class="quack-priority ${msg.priority}">${msg.priority}</span>`
        : '';

      return `
        <div class="quack-message" data-message-id="${msg.id}">
          <div class="quack-message-header">
            <span class="quack-from">${this.escapeHtml(msg.from)}${priorityBadge}</span>
            <span class="quack-time">${this.formatTime(msg.timestamp)}</span>
          </div>
          <div class="quack-task">${this.escapeHtml(msg.task)}</div>
          <div>
            <span class="quack-status ${msg.status}">${msg.status}</span>
          </div>
          ${showActions ? `
          <div class="quack-actions">
            <button class="quack-btn quack-btn-approve" data-action="approve" data-id="${msg.id}">✓ Approve</button>
            <button class="quack-btn quack-btn-reject" data-action="reject" data-id="${msg.id}">✗ Reject</button>
          </div>
          ` : ''}
        </div>
      `;
    }

    attachMessageHandlers(content) {
      content.querySelectorAll('[data-action]').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          const action = e.target.dataset.action;
          const id = e.target.dataset.id;
          await this.handleAction(action, id);
        });
      });
    }

    async handleAction(action, messageId) {
      try {
        let endpoint;
        if (action === 'approve') {
          endpoint = `${this.options.baseUrl}/api/approve/${messageId}`;
        } else if (action === 'reject') {
          endpoint = `${this.options.baseUrl}/api/reject/${messageId}`;
        }

        const res = await fetch(endpoint, { method: 'POST' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        if (action === 'approve' && this.options.onApprove) {
          const msg = this.messages.find(m => m.id === messageId);
          this.options.onApprove(msg);
        } else if (action === 'reject' && this.options.onReject) {
          const msg = this.messages.find(m => m.id === messageId);
          this.options.onReject(msg);
        }

        await this.fetchMessages();
      } catch (err) {
        console.error('QuackWidget: Action error:', err);
        if (this.options.onError) this.options.onError(err);
      }
    }

    formatTime(timestamp) {
      const date = new Date(timestamp);
      const now = new Date();
      const diff = now - date;
      
      if (diff < 60000) return 'just now';
      if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
      if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
      return date.toLocaleDateString();
    }

    escapeHtml(str) {
      if (!str) return '';
      const div = document.createElement('div');
      div.textContent = str;
      return div.innerHTML;
    }

    startPolling() {
      this.fetchMessages();
      if (this.options.pollInterval > 0) {
        this.pollTimer = setInterval(() => this.fetchMessages(), this.options.pollInterval);
      }
    }

    stopPolling() {
      if (this.pollTimer) {
        clearInterval(this.pollTimer);
        this.pollTimer = null;
      }
    }

    refresh() {
      this.fetchMessages();
    }

    destroy() {
      this.stopPolling();
      this.container.innerHTML = '';
    }
  }

  global.QuackWidget = {
    instance: null,
    init: function(options) {
      if (this.instance) {
        this.instance.destroy();
      }
      this.instance = new QuackWidget(options);
      return this.instance;
    },
    refresh: function() {
      if (this.instance) this.instance.refresh();
    },
    destroy: function() {
      if (this.instance) {
        this.instance.destroy();
        this.instance = null;
      }
    }
  };

})(typeof window !== 'undefined' ? window : this);
