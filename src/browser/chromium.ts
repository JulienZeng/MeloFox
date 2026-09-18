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
  navigate(url: string): Promise<{
    url: string;
    title: string;
  }>;
  clickText(text: string): Promise<{
    clicked: boolean;
    url: string;
    title: string;
  }>;
  listNetworkEvents(): NetworkEvent[];
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
    viewport: null
  });

  await installDouyinInjection(context, logger);

  const page = await context.newPage();
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
    listNetworkEvents() {
      return networkRecorder.list();
    },
    clearNetworkEvents() {
      networkRecorder.clear();
    },
    async stop() {
      await context.close();
    }
  };
}
