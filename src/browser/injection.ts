import type { BrowserContext } from 'playwright';
import type { AppLogger } from '../logger/index.js';

declare global {
  interface Window {
    __DOUYIN_ONEBOT_SEND_MESSAGE__?: (input: unknown) => Promise<unknown> | unknown;
  }
}

export async function installDouyinInjection(context: BrowserContext, logger: AppLogger, enableDomCapture = false): Promise<void> {
  // tsx preserves function names with an esbuild helper. Playwright serializes
  // callbacks without their module scope, so nested functions need it in-page.
  await context.addInitScript({ content: `
    if (typeof globalThis.__name !== 'function') {
      Object.defineProperty(globalThis, '__name', {
        configurable: true,
        value: (target, name) => Object.defineProperty(target, 'name', { value: name, configurable: true })
      });
    }
  ` });
  if (!enableDomCapture) {
    logger.info('消息捕获使用浏览器网络事件');
    return;
  }
  await context.addInitScript(enableDomCapture => {
    type DouyinOneBotMessage = {
      messageId: string;
      conversationId: string;
      conversationShortId?: string;
      conversationType: 'private' | 'group';
      senderId: string;
      senderName?: string;
      text?: string;
      timestamp: number;
      raw: unknown;
    };

    if (!enableDomCapture) return;

    const NativeWebSocket = window.WebSocket;

    window.WebSocket = class DouyinOneBotWebSocket extends NativeWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);

        this.addEventListener('message', event => {
          window.dispatchEvent(
            new CustomEvent('__DOUYIN_ONEBOT_WS_MESSAGE__', {
              detail: {
                url: String(url),
                dataType: typeof event.data,
                isBinary: event.data instanceof Blob || event.data instanceof ArrayBuffer
              }
            })
          );
        });
      }
    };

    const seenMessages = new Set<string>();

    function textOf(element: Element | null): string {
      return ((element as HTMLElement | null)?.innerText ?? element?.textContent ?? '').trim();
    }

    function stableId(input: string): string {
      let hash = 0;
      for (let index = 0; index < input.length; index += 1) {
        hash = (hash * 31 + input.charCodeAt(index)) | 0;
      }
      return `dom_${Math.abs(hash)}`;
    }

    function currentConversationRawTitle(): string {
      const title =
        document.querySelector('[class*="StackLayoutStackTitleBarleftTitle"]') ??
        document.querySelector('[class*="RightPanelheader"]') ??
        document.querySelector('[class*="pagespageRoot"]');
      return textOf(title).split('\n')[0].trim();
    }

    function currentConversationTitle(): string {
      return currentConversationRawTitle().replace(/\(\d+\)$/, '').trim() || 'douyin_active_conversation';
    }

    function firstContentLine(value: string): string {
      return value
        .split('\n')
        .map(line => line.trim())
        .find(Boolean) ?? '';
    }

    function inferConversationType(title: string): 'private' | 'group' {
      return /群|\(\d+\)$/.test(title) ? 'group' : 'private';
    }

    function parseMessageBox(box: Element): DouyinOneBotMessage | null {
      const column = box.querySelector('[class*="MessageBoxContentcolumnBox"]');
      const row = box.querySelector('[class*="MessageBoxContentrowBox"], [class*="TextMessageTexttextInnerContent"]');
      const columnLines = textOf(column).split('\n').map(line => line.trim()).filter(Boolean);
      const text = textOf(row) || columnLines.slice(1).join('\n');
      if (!text) {
        return null;
      }

      const senderName = columnLines.length > 1 ? columnLines[0] : '';
      const rawConversationTitle = currentConversationRawTitle();
      const conversationTitle = currentConversationTitle();
      const rawText = textOf(box);
      const messageId = stableId(`${conversationTitle}|${senderName}|${text}|${rawText}`);

      return {
        messageId,
        conversationId: conversationTitle,
        conversationShortId: conversationTitle,
        conversationType: inferConversationType(rawConversationTitle),
        senderId: senderName || 'unknown',
        senderName,
        text,
        timestamp: Date.now(),
        raw: {
          source: 'dom',
          text: rawText
        }
      };
    }

    function emitMessage(message: DouyinOneBotMessage): void {
      if (seenMessages.has(message.messageId)) {
        return;
      }
      seenMessages.add(message.messageId);
      window.dispatchEvent(
        new CustomEvent('__DOUYIN_ONEBOT_MESSAGE__', {
          detail: message
        })
      );
    }

    function scanMessages(): void {
      document
        .querySelectorAll('[class*="messageMessageBoxmessageBox"], [class*="MessageBoxContentcolumnBox"]')
        .forEach(box => {
        const message = parseMessageBox(box);
        if (message) {
          emitMessage(message);
        }
      });
    }

    function installMessageObserver(): void {
      const list = document.querySelector('[class*="messageMessageListlist"]');
      if (!list || list.getAttribute('data-douyin-onebot-observed') === 'true') {
        return;
      }

      list.setAttribute('data-douyin-onebot-observed', 'true');
      scanMessages();

      const observer = new MutationObserver(() => {
        scanMessages();
      });
      observer.observe(list, {
        childList: true,
        subtree: true,
        characterData: true
      });
    }

    const bridgeWindow = window as unknown as {
      __DOUYIN_ONEBOT_GET_CONVERSATIONS__?: () => unknown;
      __DOUYIN_ONEBOT_GET_GROUP_MEMBERS__?: (groupId: string) => unknown;
      __DOUYIN_ONEBOT_READ_ACTIVE_CONVERSATION__?: () => string;
    };

    bridgeWindow.__DOUYIN_ONEBOT_GET_CONVERSATIONS__ = () => {
      const seen = new Set<string>();
      return Array.from(document.querySelectorAll('[class*="conversationConversationItemtitle"]'))
        .map(element => firstContentLine(textOf(element)))
        .filter(Boolean)
        .filter(title => {
          if (seen.has(title)) {
            return false;
          }
          seen.add(title);
          return true;
        })
        .map(title => ({
          id: title,
          shortId: title,
          type: inferConversationType(title),
          name: title,
          raw: {
            source: 'dom'
          }
        }));
    };

    bridgeWindow.__DOUYIN_ONEBOT_GET_GROUP_MEMBERS__ = (_groupId: string) => {
      return [];
    };

    bridgeWindow.__DOUYIN_ONEBOT_READ_ACTIVE_CONVERSATION__ = () => currentConversationTitle();

    setInterval(installMessageObserver, 1000);
  }, enableDomCapture);

  logger.info('installed douyin browser injection');
}
