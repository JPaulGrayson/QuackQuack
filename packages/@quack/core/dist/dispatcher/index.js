const agentConfigs = {
    replit: {
        name: 'Replit',
        type: 'webhook',
        endpoint: '/api/task'
    },
    claude: { name: 'Claude', type: 'manual' },
    cursor: { name: 'Cursor', type: 'manual' },
    gpt: { name: 'GPT', type: 'manual' },
    gemini: { name: 'Gemini', type: 'manual' },
    grok: { name: 'Grok', type: 'manual' },
    copilot: { name: 'Copilot', type: 'manual' },
};
export class Dispatcher {
    store;
    pollInterval;
    intervalId = null;
    webhookBaseUrls = {};
    processing = new Set();
    constructor(options) {
        this.store = options.store;
        this.pollInterval = options.pollInterval || 5000;
    }
    registerWebhook(agent, baseUrl) {
        this.webhookBaseUrls[agent] = baseUrl.replace(/\/$/, '');
        console.log(`📮 Registered webhook for ${agent}: ${baseUrl}`);
    }
    unregisterWebhook(agent) {
        delete this.webhookBaseUrls[agent];
    }
    getRegisteredWebhooks() {
        return { ...this.webhookBaseUrls };
    }
    start() {
        if (this.intervalId) {
            console.log('Dispatcher already running');
            return;
        }
        console.log(`🚀 Dispatcher started (polling every ${this.pollInterval}ms)`);
        this.poll();
        this.intervalId = setInterval(() => this.poll(), this.pollInterval);
    }
    stop() {
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
            console.log('🛑 Dispatcher stopped');
        }
    }
    isRunning() {
        return this.intervalId !== null;
    }
    async poll() {
        try {
            const inboxes = await this.store.getAllInboxes();
            for (const inboxName of inboxes) {
                const messages = await this.store.checkInbox(inboxName, true);
                const approved = messages.filter((m) => m.status === 'approved');
                for (const message of approved) {
                    if (!this.processing.has(message.id)) {
                        this.processing.add(message.id);
                        this.dispatch(message).finally(() => {
                            this.processing.delete(message.id);
                        });
                    }
                }
            }
        }
        catch (error) {
            console.error('Dispatcher poll error:', error);
        }
    }
    async dispatch(message) {
        const agentName = message.to.split('/')[0];
        const config = agentConfigs[agentName];
        if (!config || config.type !== 'webhook') {
            return;
        }
        const baseUrl = this.webhookBaseUrls[agentName];
        if (!baseUrl) {
            return;
        }
        console.log(`📤 Dispatching to ${message.to}: ${message.id}`);
        try {
            await this.store.updateMessageStatus(message.id, 'in_progress');
            const response = await fetch(`${baseUrl}${config.endpoint}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    messageId: message.id,
                    task: message.task,
                    context: message.context,
                    from: message.from,
                    to: message.to,
                    files: message.files || [],
                    timestamp: message.timestamp
                })
            });
            if (!response.ok) {
                console.error(`❌ Webhook failed for ${message.to}: ${response.status}`);
                const errorText = await response.text().catch(() => 'Unknown error');
                console.error(`   Response: ${errorText}`);
            }
            else {
                console.log(`✅ Dispatched to ${message.to}: ${message.id}`);
            }
        }
        catch (error) {
            console.error(`❌ Dispatch error for ${message.to}:`, error);
        }
    }
    async dispatchNow(messageId) {
        const message = await this.store.getMessage(messageId);
        if (!message) {
            return false;
        }
        if (message.status !== 'approved') {
            console.log(`Cannot dispatch message ${messageId}: status is ${message.status}, not approved`);
            return false;
        }
        await this.dispatch(message);
        return true;
    }
}
//# sourceMappingURL=index.js.map