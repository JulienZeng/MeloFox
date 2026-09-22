import { createHash, createHmac, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import type { Page } from 'playwright';
import type { AppLogger } from '../logger/index.js';
import {
  buildEmojiReactionRequest,
  buildImageSendRequest,
  buildTextSendRequest,
  decodeSendResponse,
  type DouyinReplyReference,
  type DouyinSendProtocolContext,
  type DouyinUploadedImage
} from './send-protocol.js';
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
  private sentClientMessageIds = new Map<string, string>();
  private currentUserId: string | undefined;

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
    if (input.emojiReaction) {
      return this.sendReactionViaImApi(input);
    }

    if (input.images?.length) {
      return this.sendImagesViaImApi(input);
    }

    return this.sendViaImApi(input);
  }

  private async sendImagesViaImApi(input: DouyinSendMessageInput): Promise<DouyinSendMessageResult> {
    const conversationShortId = pickNumericConversationId(input);
    if (!conversationShortId) {
      throw new Error('Direct Douyin image send requires a numeric conversation id from realtime messages or group list');
    }
    if (!input.images?.length) {
      throw new Error('Direct Douyin image send requires at least one image');
    }
    if (input.text || input.mentions?.length || input.replyToMessageId) {
      throw new Error('Direct Douyin image send currently supports image-only messages');
    }

    const context = await this.readSendProtocolContext();
    let lastResult: DouyinSendMessageResult | undefined;
    for (const image of input.images) {
      const imageData = await loadImageData(image);
      const uploaded = await this.uploadImageViaVod(imageData);
      const request = buildImageSendRequest({
        conversationShortId,
        conversationType: input.target.type === 'group' ? 2 : 1,
        image: uploaded,
        context
      });

      const decoded = await this.postImProtobuf('message/send', request.body);
      if (!decoded.ok) {
        throw new Error(`Douyin image message/send failed: ${decoded.status ?? decoded.statusCode ?? 'unknown'}`);
      }

      const messageId = decoded.serverMessageId ?? decoded.clientMessageId ?? request.clientMessageId;
      this.sentClientMessageIds.set(messageId, request.clientMessageId);
      this.logger.info(
        {
          conversationShortId,
          messageId,
          clientMessageId: request.clientMessageId,
          imageSize: uploaded.size,
          imageWidth: uploaded.width,
          imageHeight: uploaded.height
        },
        'sent douyin image message through imapi'
      );

      lastResult = {
        messageId,
        raw: {
          source: 'imapi',
          response: decoded,
          image: uploaded
        }
      };
    }

    if (!lastResult) {
      throw new Error('No image was sent');
    }
    return lastResult;
  }

  private async sendViaImApi(input: DouyinSendMessageInput): Promise<DouyinSendMessageResult> {
    const conversationShortId = pickNumericConversationId(input);
    if (!conversationShortId) {
      throw new Error('Direct Douyin send requires a numeric conversation id from realtime messages or group list');
    }

    if (!input.text) {
      throw new Error('Direct Douyin send requires text content');
    }

    const context = await this.readSendProtocolContext();
    const request = buildTextSendRequest({
      conversationShortId,
      conversationType: input.target.type === 'group' ? 2 : 1,
      text: input.text,
      mentions: input.mentions,
      replyReference: this.buildReplyReference(input.replyToMessageId),
      context
    });

    const decoded = await this.postImProtobuf('message/send', request.body);
    if (!decoded.ok) {
      throw new Error(`Douyin message/send failed: ${decoded.status ?? decoded.statusCode ?? 'unknown'}`);
    }

    const messageId = decoded.serverMessageId ?? decoded.clientMessageId ?? request.clientMessageId;
    this.sentClientMessageIds.set(messageId, request.clientMessageId);
    this.logger.info(
      {
        conversationShortId,
        messageId,
        clientMessageId: request.clientMessageId,
        mentions: input.mentions?.length ?? 0
      },
      'sent douyin message through imapi'
    );

    return {
      messageId,
      raw: {
        source: 'imapi',
        response: decoded
      }
    };
  }

  private async postImProtobuf(endpoint: 'message/send' | 'message/set_property', body: Buffer) {
    const response = await this.page.evaluate(async payload => {
      function base64ToBytes(base64: string): Uint8Array {
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) {
          bytes[index] = binary.charCodeAt(index);
        }
        return bytes;
      }

      function bytesToBase64(bytes: Uint8Array): string {
        let binary = '';
        const chunkSize = 0x8000;
        for (let index = 0; index < bytes.length; index += chunkSize) {
          binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
        }
        return btoa(binary);
      }

      const requestBytes = base64ToBytes(payload.bodyBase64);
      const requestBody = new ArrayBuffer(requestBytes.byteLength);
      new Uint8Array(requestBody).set(requestBytes);

      const result = await fetch(`https://imapi.douyin.com/v1/${payload.endpoint}`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'content-type': 'application/x-protobuf'
        },
        body: requestBody
      });
      const body = new Uint8Array(await result.arrayBuffer());
      return {
        ok: result.ok,
        status: result.status,
        url: result.url,
        bodyBase64: bytesToBase64(body)
      };
    }, {
      bodyBase64: body.toString('base64'),
      endpoint
    });

    if (!response.ok) {
      throw new Error(`Douyin ${endpoint} HTTP failed: ${response.status}`);
    }

    return decodeSendResponse(Buffer.from(response.bodyBase64, 'base64'));
  }

  private async sendReactionViaImApi(input: DouyinSendMessageInput): Promise<DouyinSendMessageResult> {
    if (!input.replyToMessageId) {
      throw new Error('Direct Douyin emoji reaction requires a reply segment with target message id');
    }
    if (!input.emojiReaction) {
      throw new Error('Direct Douyin emoji reaction requires emoji data');
    }
    if (input.text || input.images?.length || input.mentions?.length) {
      throw new Error('Direct Douyin emoji reaction cannot be mixed with text, image, or at segments');
    }

    const target = this.buildReactionTarget(input.replyToMessageId, input.target);
    const context = await this.readSendProtocolContext();
    const request = buildEmojiReactionRequest({
      conversationShortId: target.conversationShortId,
      conversationType: target.conversationType,
      targetMessageId: input.replyToMessageId,
      targetClientMessageId: target.clientMessageId,
      operatorUserId: context.userId ?? this.currentUserId ?? input.operatorUserId ?? '0',
      emoji: input.emojiReaction,
      context
    });

    const decoded = await this.postImProtobuf('message/set_property', request.body);
    if (!decoded.ok) {
      throw new Error(`Douyin message/set_property failed: ${decoded.status ?? decoded.statusCode ?? 'unknown'}`);
    }

    this.logger.info(
      {
        conversationShortId: target.conversationShortId,
        messageId: input.replyToMessageId,
        emoji: input.emojiReaction.key
      },
      'sent douyin emoji reaction through imapi'
    );

    return {
      messageId: input.replyToMessageId,
      raw: {
        source: 'imapi',
        response: decoded
      }
    };
  }

  private async uploadImageViaVod(imageData: LoadedImageData): Promise<DouyinUploadedImage> {
    const bytes = Buffer.from(imageData.base64, 'base64');
    const uploadConfig = await this.readImageUploadConfig();
    const credentials = normalizeUploadCredentials(uploadConfig);
    const applyUrl = new URL('https://vod.bytedanceapi.com/');
    applyUrl.searchParams.set('Action', 'ApplyUploadInner');
    applyUrl.searchParams.set('Version', '2020-11-19');
    applyUrl.searchParams.set('SpaceName', credentials.spaceName);
    applyUrl.searchParams.set('FileType', 'image');
    applyUrl.searchParams.set('IsInner', '1');
    applyUrl.searchParams.set('NeedFallback', 'true');
    applyUrl.searchParams.set('FileSize', String(bytes.byteLength));
    applyUrl.searchParams.set('s', randomId(10));

    const applyResponse = await fetch(applyUrl, {
      method: 'GET',
      headers: signVodRequest('GET', applyUrl, Buffer.alloc(0), credentials)
    });
    const applyBody = await readJsonResponse(applyResponse, 'ApplyUploadInner');
    const applyResult = recordValue(applyBody.Result ?? applyBody.result, 'ApplyUploadInner.Result');
    const uploadAddress = recordValue(applyResult.UploadAddress ?? applyResult.uploadAddress, 'UploadAddress');
    const storeInfos = arrayValue(uploadAddress.StoreInfos);
    const storeInfo = recordValue(storeInfos[0], 'StoreInfos[0]');
    const uploadHosts = arrayValue(uploadAddress.UploadHosts);
    const uploadHost = stringValue(uploadHosts[0]);
    const storeUri = requireStringValue(storeInfo.StoreUri, 'StoreUri');
    const auth = requireStringValue(storeInfo.Auth, 'Auth');
    const sessionKey = requireStringValue(uploadAddress.SessionKey, 'SessionKey');

    const uploadUrl = `https://${uploadHost}/upload/v1/${storeUri}`;
    const crc32 = crc32Hex(bytes);
    const uploadResponse = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        authorization: auth,
        'content-crc32': crc32,
        'content-type': 'application/octet-stream'
      },
      body: bytes
    });
    await readJsonResponse(uploadResponse, 'TOS image upload');

    const commitUrl = new URL('https://vod.bytedanceapi.com/');
    commitUrl.searchParams.set('Action', 'CommitUploadInner');
    commitUrl.searchParams.set('Version', '2020-11-19');
    commitUrl.searchParams.set('SpaceName', credentials.spaceName);
    const commitPayload = Buffer.from(
      JSON.stringify({
        SessionKey: sessionKey,
        Functions: [
          {
            name: 'Encryption',
            input: {
              Config: {
                copies: 'cipher_v2'
              },
              PolicyParams: {
                'policy-set': 'check,thumb,medium,large'
              }
            }
          }
        ]
      }),
      'utf8'
    );
    const commitResponse = await fetch(commitUrl, {
      method: 'POST',
      headers: {
        ...signVodRequest('POST', commitUrl, commitPayload, credentials),
        'content-type': 'text/plain;charset=UTF-8'
      },
      body: commitPayload
    });
    const commitBody = await readJsonResponse(commitResponse, 'CommitUploadInner');
    const commitResult = recordValue(commitBody.Result ?? commitBody.result, 'CommitUploadInner.Result');
    const firstResult = recordValue(arrayValue(commitResult.Results ?? commitResult.results)[0], 'Results[0]');
    const encryption = recordValue(firstResult.Encryption ?? firstResult.encryption, 'Encryption');
    const extra = recordValue(encryption.Extra ?? encryption.extra, 'Encryption.Extra');
    const oid = requireStringValue(encryption.Uri ?? encryption.uri, 'Encryption.Uri');
    await this.buildImagePrivacyUrl(oid).catch(error => {
      this.logger.warn({ error: error instanceof Error ? error.message : String(error), oid }, 'douyin image privacy url build failed');
    });

    return {
      oid,
      skey: requireStringValue(encryption.SecretKey ?? encryption.secretKey, 'Encryption.SecretKey'),
      size: numberFromUnknown(extra.img_size) ?? bytes.byteLength,
      md5: requireStringValue(encryption.SourceMd5 ?? encryption.sourceMd5, 'Encryption.SourceMd5'),
      width: numberFromUnknown(extra.img_width) ?? 0,
      height: numberFromUnknown(extra.img_height) ?? 0
    };
  }

  private async readImageUploadConfig(): Promise<unknown> {
    return this.page.evaluate(async () => {
      const params = new URLSearchParams({
        device_platform: 'webapp',
        aid: '6383',
        channel: 'channel_pc_web',
        update_version_code: '170400',
        pc_client_type: '1',
        pc_libra_divert: 'Mac',
        support_h265: '1',
        support_dash: '0',
        cpu_core_num: String(navigator.hardwareConcurrency || 8),
        version_code: '170400',
        version_name: '17.4.0',
        cookie_enabled: String(navigator.cookieEnabled),
        screen_width: String(window.screen.width),
        screen_height: String(window.screen.height),
        browser_language: navigator.language,
        browser_platform: navigator.platform,
        browser_name: 'Chrome',
        browser_version: '153.0.0.0',
        browser_online: String(navigator.onLine),
        engine_name: 'Blink',
        engine_version: '153.0.0.0',
        os_name: 'Mac OS',
        os_version: '10.15.7'
      });
      const response = await fetch(`https://www.douyin.com/aweme/v1/web/im/upload/config/v2?${params}`, {
        credentials: 'include'
      });
      if (!response.ok) {
        throw new Error(`upload config failed: ${response.status}`);
      }
      return response.json();
    });
  }

  private async buildImagePrivacyUrl(uri: string): Promise<void> {
    await this.page.evaluate(async imageUri => {
      const params = new URLSearchParams({
        device_platform: 'webapp',
        aid: '6383',
        channel: 'channel_pc_web',
        pc_client_type: '1',
        pc_libra_divert: 'Mac',
        update_version_code: '170400',
        support_h265: '1',
        support_dash: '0',
        version_code: '170400',
        version_name: '17.4.0',
        cookie_enabled: String(navigator.cookieEnabled),
        screen_width: String(window.screen.width),
        screen_height: String(window.screen.height),
        browser_language: navigator.language,
        browser_platform: navigator.platform,
        browser_name: 'Chrome',
        browser_version: '153.0.0.0',
        browser_online: String(navigator.onLine),
        engine_name: 'Blink',
        engine_version: '153.0.0.0',
        os_name: 'Mac OS',
        os_version: '10.15.7'
      });
      const response = await fetch(`https://www-hj.douyin.com/aweme/v1/web/privacy/batch_build_image/?${params}`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'content-type': 'application/json; charset=UTF-8'
        },
        body: JSON.stringify({
          convert_params: [
            {
              uri: imageUri,
              format: 'tplv-x-get:large.image',
              tpl: '%s://%v/%v~%v'
            }
          ]
        })
      });
      if (!response.ok) {
        throw new Error(`privacy image build failed: ${response.status}`);
      }
      const body = await response.json() as { status_code?: number };
      if (body.status_code !== 0) {
        throw new Error(`privacy image build returned status ${body.status_code ?? 'unknown'}`);
      }
    }, uri);
  }

  private async sendViaDom(input: DouyinSendMessageInput): Promise<DouyinSendMessageResult> {
    const targetConversation = input.target.conversationShortId ?? input.target.conversationId ?? input.target.userId ?? '';
    if (targetConversation) {
      const selected = await this.selectConversation(targetConversation);
      if (!selected) {
        const conversations = await this.getConversations().catch(() => []);
        const visibleTargets = conversations.map(conversation => conversation.shortId ?? conversation.id).filter(Boolean);
        throw new Error(
          `Unable to select Douyin conversation: ${targetConversation}. Visible conversation ids: ${visibleTargets.join(', ') || '(none)'}`
        );
      }
    }

    const editor = this.page.locator('[contenteditable="true"][class*="messageEditorinputArea"]').first();
    await editor.waitFor({
      state: 'visible',
      timeout: 10_000
    });
    if (input.text) {
      await editor.fill(input.text);
      await editor.press('Enter');
    }

    for (const image of input.images ?? []) {
      const imageData = await loadImageData(image);
      await editor.focus();
      await editor.evaluate(
        (element, data) => {
          const bytes = Uint8Array.from(atob(data.base64), char => char.charCodeAt(0));
          const file = new File([bytes], data.name, { type: data.mimeType });
          const transfer = new DataTransfer();
          transfer.items.add(file);
          const event = new ClipboardEvent('paste', {
            clipboardData: transfer,
            bubbles: true,
            cancelable: true
          });
          element.dispatchEvent(event);
        },
        imageData
      );
      await this.page.waitForTimeout(1000);
      const confirmed = await this.page
        .getByText('发送', { exact: true })
        .last()
        .click({ timeout: 5_000 })
        .then(() => true)
        .catch(() => false);
      if (!confirmed) {
        await editor.press('Enter');
      }
      await this.page.waitForTimeout(1000);
    }

    const messageId = `dom_send_${Date.now()}`;
    return {
      messageId,
      raw: {
        source: 'dom'
      }
    };
  }

  private async selectConversation(target: string): Promise<boolean> {
    const targetValue = normalizeConversationText(target);
    const activeConversation = await this.readActiveConversation();
    if (!targetValue || normalizeConversationText(activeConversation) === targetValue) {
      return true;
    }

    const clickedByLocator = await this.page
      .locator('[class*="conversationConversationItemtitle"]')
      .filter({ hasText: target })
      .first()
      .click({ timeout: 5_000 })
      .then(() => true)
      .catch(() => false);

    const clicked = clickedByLocator || await this.page.evaluate(rawTarget => {
      function textOf(element: Element | null): string {
        return ((element as HTMLElement | null)?.innerText ?? element?.textContent ?? '').trim();
      }

      function firstContentLine(value: string): string {
        return (
          value
            .split('\n')
            .map(line => line.trim())
            .find(Boolean) ?? ''
        );
      }

      function normalize(value: string): string {
        return firstContentLine(value).replace(/\(\d+\)$/, '').trim().toLowerCase();
      }

      function clickableAncestor(element: Element): HTMLElement | undefined {
        let current: Element | null = element;
        while (current && current !== document.body) {
          const className = current.getAttribute('class') ?? '';
          if (/conversation/i.test(className) && current instanceof HTMLElement) {
            return current;
          }
          current = current.parentElement;
        }
        return element instanceof HTMLElement ? element : undefined;
      }

      const normalizedTarget = normalize(rawTarget);
      const titleElements = Array.from(document.querySelectorAll('[class*="conversationConversationItemtitle"]'));
      const titleElement =
        titleElements.find(element => normalize(textOf(element)) === normalizedTarget) ??
        titleElements.find(element => normalize(textOf(element)).includes(normalizedTarget));
      const clickable = titleElement ? clickableAncestor(titleElement) : undefined;
      clickable?.click();
      return Boolean(clickable);
    }, target);

    if (!clicked) {
      return false;
    }

    await this.page
      .waitForFunction(
        expected => {
          const reader = (window as unknown as { __DOUYIN_ONEBOT_READ_ACTIVE_CONVERSATION__?: () => string }).__DOUYIN_ONEBOT_READ_ACTIVE_CONVERSATION__;
          const active = typeof reader === 'function' ? reader() : '';
          const normalize = (value: string) => value.split('\n')[0]?.replace(/\(\d+\)$/, '').trim().toLowerCase() ?? '';
          return normalize(active) === normalize(expected);
        },
        target,
        { timeout: 5_000 }
      )
      .catch(() => undefined);

    const selectedConversation = await this.readActiveConversation();
    if (normalizeConversationText(selectedConversation) === targetValue) {
      return true;
    }

    const editorVisible = await this.page
      .locator('[contenteditable="true"][class*="messageEditorinputArea"]')
      .first()
      .isVisible()
      .catch(() => false);
    this.logger.debug(
      { target, activeConversation: selectedConversation, editorVisible },
      'douyin active conversation check did not match after selecting visible target'
    );
    return editorVisible;
  }

  private async readActiveConversation(): Promise<string> {
    return this.page
      .evaluate(() => {
        const reader = (window as unknown as { __DOUYIN_ONEBOT_READ_ACTIVE_CONVERSATION__?: () => string }).__DOUYIN_ONEBOT_READ_ACTIVE_CONVERSATION__;
        return typeof reader === 'function' ? reader() : '';
      })
      .catch(() => '');
  }

  private async validateSendResult(result: unknown): Promise<DouyinSendMessageResult> {
    if (!isSendResult(result)) {
      throw new Error('Douyin send hook returned an invalid result');
    }

    return result;
  }

  private async readSendProtocolContext(): Promise<DouyinSendProtocolContext> {
    return this.page.evaluate(() => {
      function allStorageValues(): string[] {
        const values: string[] = [];
        for (const storage of [window.localStorage, window.sessionStorage]) {
          for (let index = 0; index < storage.length; index += 1) {
            values.push(storage.getItem(storage.key(index) ?? '') ?? '');
          }
        }
        return values;
      }

      function storageValues(): string[] {
        const values: string[] = [];
        for (const storage of [window.localStorage, window.sessionStorage]) {
          for (let index = 0; index < storage.length; index += 1) {
            const key = storage.key(index) ?? '';
            const value = storage.getItem(key) ?? '';
            if (/identity|security|token|device|webid|fp/i.test(`${key}\n${value}`)) {
              values.push(value);
            }
          }
        }
        return values;
      }

      function pickToken(): string | undefined {
        for (const value of storageValues()) {
          try {
            const parsed = JSON.parse(value) as unknown;
            if (
              typeof parsed === 'object' &&
              parsed !== null &&
              typeof (parsed as { token?: unknown }).token === 'string'
            ) {
              return JSON.stringify({ token: (parsed as { token: string }).token });
            }
          } catch {
            // Some storage entries are plain strings; skip JSON parsing failures.
          }

          const token = value.match(/"token"\s*:\s*"([^"]+)"/)?.[1];
          if (token) {
            return JSON.stringify({ token });
          }
        }
        return undefined;
      }

      function cookieValue(name: string): string | undefined {
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return document.cookie.match(new RegExp(`(?:^|; )${escaped}=([^;]*)`))?.[1];
      }

      function pickUserId(): string | undefined {
        const cookieUserId = cookieValue('uid_tt') ?? cookieValue('uid_tt_ss');
        if (cookieUserId && /^\d+$/.test(cookieUserId)) {
          return cookieUserId;
        }

        for (const value of allStorageValues()) {
          const matches = value.match(/(?:"user_id"|"uid"|"webcast_uid")\s*:\s*"?(\d{6,})"?/g) ?? [];
          for (const match of matches) {
            const id = match.match(/(\d{6,})/)?.[1];
            if (id) {
              return id;
            }
          }
        }
        return undefined;
      }

      const browserName = navigator.userAgent.includes('Chrome') ? 'Mozilla' : navigator.appCodeName || 'Mozilla';
      return {
        userAgent: navigator.userAgent,
        language: navigator.language,
        platform: navigator.platform,
        cookieEnabled: navigator.cookieEnabled,
        browserName,
        browserVersion: navigator.userAgent.replace(/^Mozilla\//, ''),
        online: navigator.onLine,
        screenWidth: window.screen.width,
        screenHeight: window.screen.height,
        timezoneName: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai',
        deviceId: cookieValue('webid') ?? cookieValue('ttwid') ?? '0',
        userId: pickUserId(),
        identitySecurityToken: pickToken()
      };
    });
  }

  private buildReplyReference(messageId: string | undefined): DouyinReplyReference | undefined {
    if (!messageId) {
      return undefined;
    }
    if (!/^\d+$/.test(messageId)) {
      throw new Error(`Direct Douyin reply requires a numeric message id: ${messageId}`);
    }

    const cached = this.messageCache.get(messageId);
    if (!cached) {
      throw new Error(`Cannot reply to message outside the realtime cache: ${messageId}`);
    }

    const payload = isRecord(cached.raw) && isRecord(cached.raw.payload) ? cached.raw.payload : {};
    const originalContent = normalizeReplyContent(
      typeof payload.content === 'string' ? payload.content : cached.content,
      cached.text ?? '',
      cached.messageType ?? numberValue(payload.messageType) ?? 7
    );
    return {
      messageId,
      content: cached.text ?? '',
      originalContent,
      messageType: cached.messageType ?? numberValue(payload.messageType) ?? 7,
      senderId: cached.senderId,
      secSender: stringValue(payload.secSender),
      nickname: cached.senderName ?? '',
      indexInConversation: stringValue(payload.indexInConversation)
    };
  }

  private buildReactionTarget(
    messageId: string,
    fallbackTarget: DouyinSendMessageInput['target']
  ): { conversationShortId: string; conversationType: 1 | 2; clientMessageId: string } {
    if (!/^\d+$/.test(messageId)) {
      throw new Error(`Direct Douyin emoji reaction requires a numeric message id: ${messageId}`);
    }

    const cached = this.messageCache.get(messageId);
    if (!cached) {
      throw new Error(`Cannot react to message outside the realtime cache: ${messageId}`);
    }

    const payload = isRecord(cached.raw) && isRecord(cached.raw.payload) ? cached.raw.payload : {};
    const conversationShortId =
      cached.conversationShortId ??
      stringValue(payload.conversationShortId) ??
      fallbackTarget.conversationShortId ??
      fallbackTarget.conversationId ??
      fallbackTarget.userId;
    if (!conversationShortId || !/^\d+$/.test(conversationShortId)) {
      throw new Error(`Direct Douyin emoji reaction requires a numeric conversation id for message: ${messageId}`);
    }

    const clientMessageId =
      cached.clientMessageId ??
      stringValue(payload.clientMessageId) ??
      extractEntityValue(payload.ext, 's:client_message_id') ??
      this.sentClientMessageIds.get(messageId);
    if (!clientMessageId) {
      throw new Error(`Direct Douyin emoji reaction requires cached client_message_id for message: ${messageId}`);
    }

    return {
      conversationShortId,
      conversationType: cached.conversationType === 'group' ? 2 : 1,
      clientMessageId
    };
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
    const isOwnEcho = Boolean(message.clientMessageId && this.sentClientMessageIds.get(message.messageId) === message.clientMessageId);
    if (message.clientMessageId) {
      this.sentClientMessageIds.set(message.messageId, message.clientMessageId);
    }
    if (isOwnEcho) {
      this.currentUserId = message.senderId;
    }
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

function normalizeConversationText(value: string): string {
  return (
    value
      .split('\n')
      .map(line => line.trim())
      .find(Boolean)
      ?.replace(/\(\d+\)$/, '')
      .trim()
      .toLowerCase() ?? ''
  );
}

function normalizeReplyContent(content: string | undefined, text: string, messageType: number): string {
  const parsed = parseJsonObject(content);
  if (parsed && typeof parsed.instruction_type === 'number' && typeof parsed.item_type_local === 'number') {
    return JSON.stringify(parsed);
  }

  const parsedText = parsed ? stringValue(parsed.text) : undefined;
  const parsedAweType = parsed ? numberValue(parsed.aweType) : undefined;
  return JSON.stringify({
    type: 0,
    instruction_type: 0,
    item_type_local: -1,
    text: parsedText ?? text,
    createdAt: 0,
    is_card: false,
    msgHint: '',
    aweType: parsedAweType ?? (messageType === 7 ? 700 : messageType)
  });
}

function parseJsonObject(value: string | undefined): Record<string, unknown> | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function extractEntityValue(value: unknown, key: string): string | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  for (const item of value) {
    if (!isRecord(item)) {
      continue;
    }
    if (stringValue(item.key) === key) {
      return stringValue(item.value);
    }
  }
  return undefined;
}

function pickNumericConversationId(input: DouyinSendMessageInput): string | undefined {
  const candidates = [
    input.target.conversationShortId,
    input.target.conversationId,
    input.target.userId
  ];
  return candidates.find((value): value is string => typeof value === 'string' && /^\d+$/.test(value));
}

interface LoadedImageData {
  base64: string;
  mimeType: string;
  name: string;
}

interface UploadCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  spaceName: string;
}

async function loadImageData(file: string): Promise<LoadedImageData> {
  if (/^base64:\/\//i.test(file)) {
    const base64 = file.replace(/^base64:\/\//i, '');
    const buffer = Buffer.from(base64, 'base64');
    return {
      base64,
      mimeType: detectImageMime(buffer) ?? 'image/png',
      name: `onebot-image${extensionFromMime(detectImageMime(buffer) ?? 'image/png')}`
    };
  }

  const dataUriMatch = file.match(/^data:([^;,]+);base64,(.+)$/i);
  if (dataUriMatch) {
    return {
      base64: dataUriMatch[2],
      mimeType: dataUriMatch[1] || 'image/png',
      name: `onebot-image${extensionFromMime(dataUriMatch[1] || 'image/png')}`
    };
  }

  if (/^https?:\/\//i.test(file)) {
    const response = await fetch(file);
    if (!response.ok) {
      throw new Error(`Failed to fetch outgoing image: ${response.status}`);
    }
    const contentType = response.headers.get('content-type') ?? 'image/png';
    return {
      base64: Buffer.from(await response.arrayBuffer()).toString('base64'),
      mimeType: contentType.split(';')[0] || 'image/png',
      name: `onebot-image${extensionFromMime(contentType)}`
    };
  }

  const path = file.startsWith('file://') ? new URL(file) : file;
  const buffer = await readFile(path);
  return {
    base64: buffer.toString('base64'),
    mimeType: mimeFromPath(typeof path === 'string' ? path : path.pathname),
    name: basename(typeof path === 'string' ? path : path.pathname) || 'onebot-image.png'
  };
}

function normalizeUploadCredentials(value: unknown): UploadCredentials {
  const root = recordValue(value, 'upload config');
  const config =
    optionalRecord(root.public_image_config) ??
    optionalRecord(root.public_image_config_v2) ??
    optionalRecord(root.inner_image_config);
  if (!config) {
    throw new Error('Douyin image upload config did not contain public_image_config_v2');
  }

  return {
    accessKeyId: requireStringValue(config.access_key_id, 'access_key_id'),
    secretAccessKey: requireStringValue(config.secret_access_key, 'secret_access_key'),
    sessionToken: requireStringValue(config.session_token, 'session_token').split('|')[0] ?? '',
    spaceName: requireStringValue(config.space_name, 'space_name')
  };
}

function signVodRequest(
  method: 'GET' | 'POST',
  url: URL,
  body: Buffer,
  credentials: UploadCredentials
): Record<string, string> {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(body);
  const baseHeaders: Record<string, string> = {
    'x-amz-date': amzDate,
    'x-amz-security-token': credentials.sessionToken
  };
  if (method === 'POST') {
    baseHeaders['x-amz-content-sha256'] = payloadHash;
  }

  const signedHeaderNames = Object.keys(baseHeaders).sort();
  const canonicalHeaders = signedHeaderNames.map(key => `${key}:${baseHeaders[key].trim()}\n`).join('');
  const canonicalRequest = [
    method,
    url.pathname || '/',
    canonicalQueryString(url.searchParams),
    canonicalHeaders,
    signedHeaderNames.join(';'),
    payloadHash
  ].join('\n');
  const credentialScope = `${date}/cn-north-1/vod/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256Hex(Buffer.from(canonicalRequest, 'utf8'))
  ].join('\n');

  const signingKey = hmac(
    hmac(
      hmac(hmac(Buffer.from(`AWS4${credentials.secretAccessKey}`, 'utf8'), date), 'cn-north-1'),
      'vod'
    ),
    'aws4_request'
  );
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');
  return {
    ...baseHeaders,
    authorization: `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaderNames.join(';')}, Signature=${signature}`
  };
}

function hmac(key: Buffer, value: string): Buffer {
  return createHmac('sha256', key).update(value).digest();
}

function sha256Hex(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalQueryString(params: URLSearchParams): string {
  return [...params.entries()]
    .map(([key, value]) => [encodeRfc3986(key), encodeRfc3986(value)] as const)
    .sort(([leftKey, leftValue], [rightKey, rightValue]) => {
      if (leftKey === rightKey) {
        return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
      }
      return leftKey < rightKey ? -1 : 1;
    })
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
}

function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

async function readJsonResponse(response: Response, label: string): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${label} failed: ${response.status} ${text.slice(0, 200)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${label} returned non-JSON response: ${text.slice(0, 200)}`);
  }
  const record = recordValue(parsed, label);
  const responseMetadata = optionalRecord(record.ResponseMetadata ?? record.responseMetadata);
  const error = optionalRecord(responseMetadata?.Error ?? responseMetadata?.error);
  if (error) {
    throw new Error(`${label} returned error: ${JSON.stringify(error).slice(0, 400)}`);
  }
  return record;
}

function crc32Hex(buffer: Buffer): string {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ byte) & 0xff];
  }
  return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0');
}

const CRC32_TABLE = (() => {
  const table: number[] = [];
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function randomId(length: number): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let value = '';
  for (let index = 0; index < length; index += 1) {
    value += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return value;
}

function detectImageMime(buffer: Buffer): string | undefined {
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    return 'image/jpeg';
  }
  if (buffer.subarray(0, 3).toString('ascii') === 'GIF') {
    return 'image/gif';
  }
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }
  return undefined;
}

function mimeFromPath(path: string): string {
  const extension = extname(path).toLowerCase();
  if (extension === '.jpg' || extension === '.jpeg') {
    return 'image/jpeg';
  }
  if (extension === '.webp') {
    return 'image/webp';
  }
  if (extension === '.gif') {
    return 'image/gif';
  }
  return 'image/png';
}

function extensionFromMime(mimeType: string): string {
  if (/jpeg/i.test(mimeType)) {
    return '.jpg';
  }
  if (/webp/i.test(mimeType)) {
    return '.webp';
  }
  if (/gif/i.test(mimeType)) {
    return '.gif';
  }
  return '.png';
}

function recordValue(value: unknown, label: string): Record<string, unknown> {
  if (isRecord(value)) {
    return value;
  }
  throw new Error(`Expected ${label} to be an object, got ${typeof value}: ${previewValue(value)}`);
}

function previewValue(value: unknown): string {
  if (value === undefined) {
    return 'undefined';
  }
  try {
    return JSON.stringify(value)?.slice(0, 300) ?? String(value);
  } catch {
    return String(value).slice(0, 300);
  }
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function arrayValue(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  throw new Error('Expected Douyin upload response field to be an array');
}

function requireStringValue(value: unknown, label: string): string {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'bigint') {
    return String(value);
  }
  throw new Error(`Expected ${label} to be a string`);
}

function numberFromUnknown(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'bigint') {
    return String(value);
  }
  return undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string' && value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}
