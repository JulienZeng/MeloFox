import type { DouyinBridge, DouyinMessageHandler } from './bridge.js';

export function registerDouyinMessageListener(bridge: DouyinBridge, handler: DouyinMessageHandler): void {
  bridge.onMessage(message => {
    // The bridge has already cached this message; suppress only its OneBot event.
    const selfId = bridge.accountId;
    if (selfId && message.senderId === selfId) return;
    return handler(message);
  });
}
