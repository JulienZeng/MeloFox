import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { chromium, type BrowserContext, type Page } from 'playwright';
import type { AppConfig } from '../config/index.js';
import type { AppLogger } from '../logger/index.js';
import { installDouyinInjection } from './injection.js';
import { attachNetworkDiagnostics, type NetworkEvent } from './network.js';

export interface BrowserRuntime {
  context: BrowserContext;
  page: Page;
  inspect(): Promise<{
    url: string;
    title: string;
    text: string;
  }>;
  inspectDom(): Promise<{
    inputs: Array<{ type: string; accept: string; multiple: boolean; className: string; ariaLabel: string; title: string }>;
    buttons: Array<{ text: string; className: string; ariaLabel: string; title: string }>;
  }>;
  inspectMessages(): Promise<{
    messages: Array<{ index: number; text: string; className: string; rect: { x: number; y: number; width: number; height: number } }>;
    menus: Array<{ text: string; className: string; rect: { x: number; y: number; width: number; height: number } }>;
  }>;
  replyToMessageText(text: string, reply: string): Promise<{
    ok: boolean;
    step: string;
    pageText?: string;
  }>;
  inspectMessageControls(text: string): Promise<{
    ok: boolean;
    step: string;
    controls?: Array<{
      text: string;
      className: string;
      ariaLabel: string;
      title: string;
      tagName: string;
      src: string;
      style: string;
      html: string;
      rect: { x: number; y: number; width: number; height: number };
    }>;
    pageText?: string;
  }>;
  navigate(url: string): Promise<{
    url: string;
    title: string;
  }>;
  clickText(text: string): Promise<{
    clicked: boolean;
    url: string;
    title: string;
  }>;
  sendImageFromFile(file: string): Promise<{
    ok: boolean;
    step: string;
    pageText?: string;
  }>;
  listNetworkEvents(): NetworkEvent[];
  listSetPropertyNetworkEvents(): NetworkEvent[];
  clearNetworkEvents(): void;
  stop(): Promise<void>;
}

export async function startBrowserRuntime(config: AppConfig, logger: AppLogger): Promise<BrowserRuntime> {
  logger.info(
    {
      userDataDir: config.browser.userDataDir,
      headless: config.browser.headless
    },
    'starting persistent chromium'
  );

  const context = await chromium.launchPersistentContext(config.browser.userDataDir, {
    headless: config.browser.headless,
    viewport: {
      width: 1710,
      height: 1112
    },
    screen: {
      width: 1710,
      height: 1112
    },
    args: ['--window-size=1710,1112', '--start-maximized']
  });

  await installDouyinInjection(context, logger);

  const page = await context.newPage();
  await page.setViewportSize({ width: 1710, height: 1112 }).catch(() => undefined);
  await page.bringToFront();

  await Promise.all(
    context
      .pages()
      .filter(existingPage => existingPage !== page)
      .map(existingPage => existingPage.close({ runBeforeUnload: false }).catch(() => undefined))
  );

  const networkRecorder = attachNetworkDiagnostics(page, logger);

  await page.goto(config.douyin.messagePageUrl, {
    waitUntil: 'domcontentloaded'
  });

  logger.info({ url: page.url() }, 'douyin chat page opened');

  return {
    context,
    page,
    async inspect() {
      const [title, bodyText] = await Promise.all([
        page.title().catch(() => ''),
        page
          .locator('body')
          .innerText({ timeout: 5000 })
          .catch(() => '')
      ]);

      return {
        url: page.url(),
        title,
        text: bodyText.slice(0, 8000)
      };
    },
    async inspectDom() {
      return page.evaluate(() => {
        const textOf = (element: Element) => ((element as HTMLElement).innerText ?? element.textContent ?? '').trim().slice(0, 80);
        const classOf = (element: Element) => String(element.getAttribute('class') ?? '').slice(0, 160);
        return {
          inputs: Array.from(document.querySelectorAll('input')).map(input => ({
            type: input.type,
            accept: input.accept,
            multiple: input.multiple,
            className: classOf(input),
            ariaLabel: input.getAttribute('aria-label') ?? '',
            title: input.getAttribute('title') ?? ''
          })),
          buttons: Array.from(document.querySelectorAll('button, [role="button"]')).map(button => ({
            text: textOf(button),
            className: classOf(button),
            ariaLabel: button.getAttribute('aria-label') ?? '',
            title: button.getAttribute('title') ?? ''
          }))
        };
      });
    },
    async inspectMessages() {
      return page.evaluate(() => {
        function textOf(element: Element): string {
          return ((element as HTMLElement).innerText ?? element.textContent ?? '').trim();
        }

        function rectOf(element: Element): { x: number; y: number; width: number; height: number } {
          const rect = element.getBoundingClientRect();
          return {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height)
          };
        }

        const messageSelectors = [
          '[class*="messageMessageBoxmessageBox"]',
          '[class*="MessageBoxContentcolumnBox"]',
          '[class*="TextMessageTexttextInnerContent"]',
          '[class*="messageMessageItem"]'
        ];
        const seen = new Set<Element>();
        const messages: Array<{ index: number; text: string; className: string; rect: { x: number; y: number; width: number; height: number } }> = [];
        for (const selector of messageSelectors) {
          for (const element of Array.from(document.querySelectorAll(selector))) {
            if (seen.has(element)) {
              continue;
            }
            seen.add(element);
            const text = textOf(element);
            if (!text) {
              continue;
            }
            messages.push({
              index: messages.length,
              text: text.slice(0, 500),
              className: String(element.getAttribute('class') ?? '').slice(0, 200),
              rect: rectOf(element)
            });
          }
        }

        const menus = Array.from(document.querySelectorAll('[role="menu"], [role="menuitem"], [class*="menu"], [class*="Menu"], [class*="popover"], [class*="Popover"]'))
          .map(element => ({
            text: textOf(element).slice(0, 300),
            className: String(element.getAttribute('class') ?? '').slice(0, 200),
            rect: rectOf(element)
          }))
          .filter(item => item.text || item.className);

        return { messages, menus };
      });
    },
    async replyToMessageText(text: string, reply: string) {
      const target = page
        .locator('[class*="messageMessageBoxmessageBox"], [class*="MessageBoxContentcolumnBox"], [class*="TextMessageTexttextInnerContent"]')
        .filter({ hasText: text })
        .last();
      const found = await target.isVisible({ timeout: 5_000 }).catch(() => false);
      if (!found) {
        return {
          ok: false,
          step: 'message-not-found',
          pageText: await page.locator('body').innerText({ timeout: 2_000 }).catch(() => '')
        };
      }

      await target.hover();
      await page.waitForTimeout(500);
      await target.click({ button: 'right' }).catch(async () => {
        await target.hover();
      });
      await page.waitForTimeout(500);

      const replyEntry = page.getByText('回复', { exact: true }).last();
      const replyVisible = await replyEntry.isVisible({ timeout: 2_000 }).catch(() => false);
      if (!replyVisible) {
        return {
          ok: false,
          step: 'reply-menu-not-found',
          pageText: await page.locator('body').innerText({ timeout: 2_000 }).catch(() => '')
        };
      }

      await replyEntry.click();
      const editor = page.locator('[contenteditable="true"][class*="messageEditorinputArea"]').first();
      await editor.waitFor({ state: 'visible', timeout: 5_000 });
      await editor.fill(reply);
      await editor.press('Enter');
      return {
        ok: true,
        step: 'sent'
      };
    },
    async inspectMessageControls(text: string) {
      const messageTarget = page
        .locator('[class*="messageMessageBoxmessageBox"], [class*="MessageBoxContentcolumnBox"], [class*="TextMessageTexttextInnerContent"], [class*="message"], [class*="Message"]')
        .filter({ hasText: text })
        .last();
      const exactTextTarget = page.getByText(text).last();
      const target = (await messageTarget.isVisible({ timeout: 2_000 }).catch(() => false)) ? messageTarget : exactTextTarget;
      const found = await target.isVisible({ timeout: 5_000 }).catch(() => false);
      if (!found) {
        return {
          ok: false,
          step: 'message-not-found',
          pageText: await page.locator('body').innerText({ timeout: 2_000 }).catch(() => '')
        };
      }

      await target.hover();
      await page.waitForTimeout(500);
      await target.click({ button: 'right' }).catch(async () => {
        await target.hover();
      });
      await page.waitForTimeout(500);

      const targetBox = await target.boundingBox();
      const controls = await page.evaluate(box => {
        function textOf(element: Element): string {
          return ((element as HTMLElement).innerText ?? element.textContent ?? '').trim();
        }

        function rectOf(element: Element): { x: number; y: number; width: number; height: number } {
          const rect = element.getBoundingClientRect();
          return {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height)
          };
        }

        function isNearMessage(rect: { x: number; y: number; width: number; height: number }): boolean {
          if (!box) {
            return true;
          }
          const left = box.x - 220;
          const right = box.x + box.width + 220;
          const top = box.y - 160;
          const bottom = box.y + box.height + 160;
          return rect.x + rect.width >= left && rect.x <= right && rect.y + rect.height >= top && rect.y <= bottom;
        }

        const selectors = [
          '*'
        ];
        const seen = new Set<Element>();
        return selectors.flatMap(selector =>
          Array.from(document.querySelectorAll(selector)).flatMap(element => {
            if (seen.has(element)) {
              return [];
            }
            seen.add(element);
            const rect = rectOf(element);
            const className = String(element.getAttribute('class') ?? '').slice(0, 200);
            if (!isNearMessage(rect)) {
              return [];
            }
            const item = {
              text: textOf(element).slice(0, 300),
              className,
              ariaLabel: element.getAttribute('aria-label') ?? '',
              title: element.getAttribute('title') ?? '',
              tagName: element.tagName.toLowerCase(),
              src: element instanceof HTMLImageElement ? element.currentSrc || element.src : '',
              style: element.getAttribute('style') ?? '',
              html: element.outerHTML.slice(0, 500),
              rect
            };
            if (!item.text && !item.className && !item.ariaLabel && !item.title && !item.src && !item.style) {
              return [];
            }
            if (rect.width <= 0 || rect.height <= 0 || rect.width > 1200 || rect.height > 500) {
              return [];
            }
            return [item];
          })
        );
      }, targetBox);

      return {
        ok: true,
        step: 'inspected',
        controls
      };
    },
    async navigate(url: string) {
      await page.goto(url, {
        waitUntil: 'domcontentloaded'
      });
      await page.bringToFront();

      return {
        url: page.url(),
        title: await page.title().catch(() => '')
      };
    },
    async clickText(text: string) {
      const candidates = await page.getByText(text, { exact: true }).all();
      for (const candidate of candidates) {
        if (await candidate.isVisible().catch(() => false)) {
          await candidate.click({ force: true });
          await page.waitForTimeout(1000);
          return {
            clicked: true,
            url: page.url(),
            title: await page.title().catch(() => '')
          };
        }
      }

      return {
        clicked: false,
        url: page.url(),
        title: await page.title().catch(() => '')
      };
    },
    async sendImageFromFile(file: string) {
      const imageData = await loadImageData(file);
      const editor = page.locator('[contenteditable="true"][class*="messageEditorinputArea"]').first();
      const editorVisible = await editor.isVisible({ timeout: 5_000 }).catch(() => false);
      if (!editorVisible) {
        return {
          ok: false,
          step: 'editor-not-visible',
          pageText: await page.locator('body').innerText({ timeout: 2_000 }).catch(() => '')
        };
      }

      await editor.focus();
      await editor.evaluate(
        (element, data) => {
          const bytes = Uint8Array.from(atob(data.base64), char => char.charCodeAt(0));
          const fileObject = new File([bytes], data.name, { type: data.mimeType });
          const transfer = new DataTransfer();
          transfer.items.add(fileObject);
          const event = new ClipboardEvent('paste', {
            clipboardData: transfer,
            bubbles: true,
            cancelable: true
          });
          element.dispatchEvent(event);
        },
        imageData
      );
      await page.waitForTimeout(1_000);

      const sendClicked = await page
        .getByText('发送', { exact: true })
        .last()
        .click({ timeout: 5_000 })
        .then(() => true)
        .catch(() => false);
      if (!sendClicked) {
        await editor.press('Enter').catch(() => undefined);
      }

      await page.waitForTimeout(1_000);
      return {
        ok: true,
        step: sendClicked ? 'clicked-send' : 'pressed-enter'
      };
    },
    listNetworkEvents() {
      return networkRecorder.list();
    },
    listSetPropertyNetworkEvents() {
      return networkRecorder.list().filter(event => /\/v1\/message\/set_property/i.test(event.url));
    },
    clearNetworkEvents() {
      networkRecorder.clear();
    },
    async stop() {
      await context.close();
    }
  };
}

async function loadImageData(file: string): Promise<{ base64: string; mimeType: string; name: string }> {
  const path = file.startsWith('file://') ? new URL(file) : file;
  const buffer = await readFile(path);
  const pathName = typeof path === 'string' ? path : path.pathname;
  return {
    base64: buffer.toString('base64'),
    mimeType: mimeFromPath(pathName),
    name: basename(pathName) || 'onebot-image.png'
  };
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
