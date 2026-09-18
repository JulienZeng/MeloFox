import type { Page } from 'playwright';
import type { AppLogger } from '../logger/index.js';
import type {
  DouyinConversation,
  DouyinGroupMember,
  DouyinMessage,
  DouyinSendMessageInput,
  DouyinSendMessageResult
} from './types.js';

export type DouyinMessageHandler = (message: DouyinMessage) => void | Promise<void>;

export interface DouyinBridgeOptions {
  enableDomMessageCapture?: boolean;
}

export class DouyinBridge {
  private messageHandlers = new Set<DouyinMessageHandler>();
  private messageCache = new Map<string, DouyinMessage>();

  constructor(
    private readonly page: Page,
    private readonly logger: AppLogger,
    private readonly options: DouyinBridgeOptions = {}
  ) {}

  async start(): Promise<void> {
    if (!this.options.enableDomMessageCapture) {
      this.logger.info('douyin bridge started with realtime network capture');
      return;
    }

    await this.page.exposeBinding('__douyinOneBotEmitMessage', async (_source, message: DouyinMessage) => {
      await this.handleMessage(message);
    });

    await this.page.evaluate(() => {
      window.addEventListener('__DOUYIN_ONEBOT_MESSAGE__', event => {
        const customEvent = event as CustomEvent;
        const emitter = (window as unknown as { __douyinOneBotEmitMessage?: (message: unknown) => Promise<void> }).__douyinOneBotEmitMessage;
        void emitter?.(customEvent.detail);
      });
    });

    this.logger.info('douyin bridge started with DOM message capture fallback');
  }

  onMessage(handler: DouyinMessageHandler): void {
    this.messageHandlers.add(handler);
  }

  getCachedMessage(messageId: string): DouyinMessage | undefined {
    return this.messageCache.get(messageId);
  }

  async ingestMessage(message: DouyinMessage): Promise<void> {
    await this.handleMessage(message);
  }

  async sendMessage(input: DouyinSendMessageInput): Promise<DouyinSendMessageResult> {
    const result = await this.page.evaluate(async payload => {
      if (typeof window.__DOUYIN_ONEBOT_SEND_MESSAGE__ !== 'function') {
        return null;
      }

      return window.__DOUYIN_ONEBOT_SEND_MESSAGE__(payload);
    }, input);

    if (isSendResult(result)) {
      return result;
    }

    return this.sendViaDom(input);
  }

  private async sendViaDom(input: DouyinSendMessageInput): Promise<DouyinSendMessageResult> {
    const activeConversation = await this.page
      .evaluate(() => {
        const reader = (window as unknown as { __DOUYIN_ONEBOT_READ_ACTIVE_CONVERSATION__?: () => string }).__DOUYIN_ONEBOT_READ_ACTIVE_CONVERSATION__;
        return typeof reader === 'function' ? reader() : '';
      })
      .catch(() => '');

    const targetConversation = input.target.conversationShortId ?? input.target.conversationId ?? input.target.userId ?? '';
    if (targetConversation && activeConversation && targetConversation !== activeConversation) {
      throw new Error(`DOM sending only supports the active conversation. active=${activeConversation}, target=${targetConversation}`);
    }

    const editor = this.page.locator('[contenteditable="true"][class*="messageEditorinputArea"]').first();
    await editor.waitFor({
      state: 'visible',
      timeout: 10_000
    });
    await editor.fill(input.text);
    await editor.press('Enter');

    const messageId = `dom_send_${Date.now()}`;
    return {
      messageId,
      raw: {
        source: 'dom'
      }
    };
  }

  private async validateSendResult(result: unknown): Promise<DouyinSendMessageResult> {
    if (!isSendResult(result)) {
      throw new Error('Douyin send hook returned an invalid result');
    }

    return result;
  }

  async getConversations(): Promise<DouyinConversation[]> {
    const result = await this.page.evaluate(() => {
      const reader = (window as unknown as { __DOUYIN_ONEBOT_GET_CONVERSATIONS__?: () => unknown }).__DOUYIN_ONEBOT_GET_CONVERSATIONS__;
      return typeof reader === 'function' ? reader() : [];
    });

    return Array.isArray(result) ? (result as DouyinConversation[]) : [];
  }

  async getGroupMembers(groupId: string): Promise<DouyinGroupMember[]> {
    const result = await this.page.evaluate(id => {
      const reader = (window as unknown as { __DOUYIN_ONEBOT_GET_GROUP_MEMBERS__?: (groupId: string) => unknown }).__DOUYIN_ONEBOT_GET_GROUP_MEMBERS__;
      return typeof reader === 'function' ? reader(id) : [];
    }, groupId);

    return Array.isArray(result) ? (result as DouyinGroupMember[]) : [];
  }

  private async handleMessage(message: DouyinMessage): Promise<void> {
    this.messageCache.set(message.messageId, message);
    this.logger.info(
      {
        messageId: message.messageId,
        conversationType: message.conversationType,
        conversationId: message.conversationId,
        senderId: message.senderId
      },
      'received douyin message'
    );

    for (const handler of this.messageHandlers) {
      await handler(message);
    }
  }
}

function isSendResult(value: unknown): value is DouyinSendMessageResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as DouyinSendMessageResult).messageId === 'string'
  );
}
