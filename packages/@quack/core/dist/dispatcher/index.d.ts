import { QuackStore } from '../store/index.js';
export interface DispatcherOptions {
    store: QuackStore;
    pollInterval?: number;
}
export declare class Dispatcher {
    private store;
    private pollInterval;
    private intervalId;
    private webhookBaseUrls;
    private processing;
    constructor(options: DispatcherOptions);
    registerWebhook(agent: string, baseUrl: string): void;
    unregisterWebhook(agent: string): void;
    getRegisteredWebhooks(): Record<string, string>;
    start(): void;
    stop(): void;
    isRunning(): boolean;
    private poll;
    private dispatch;
    dispatchNow(messageId: string): Promise<boolean>;
}
//# sourceMappingURL=index.d.ts.map