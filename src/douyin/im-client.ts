import type { Page } from 'playwright';

export async function postImApi(page: Page, path: string, body: Buffer, timeoutMs: number): Promise<Buffer> {
  const response = await page.evaluate(async input => {
    const bytes = Uint8Array.from(atob(input.body), char => char.charCodeAt(0));
    const requestBody = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(requestBody).set(bytes);
    const result = await fetch(`https://imapi.douyin.com/${input.path}`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/x-protobuf' },
      body: requestBody,
      signal: AbortSignal.timeout(input.timeoutMs)
    });
    const buffer = new Uint8Array(await result.arrayBuffer());
    let binary = '';
    for (let offset = 0; offset < buffer.length; offset += 0x8000) {
      binary += String.fromCharCode(...buffer.subarray(offset, offset + 0x8000));
    }
    return { ok: result.ok, status: result.status, body: btoa(binary) };
  }, { path, body: body.toString('base64'), timeoutMs }).catch(cause => {
    throw new Error(`抖音 IM 请求未完成（https://imapi.douyin.com/${path}）；请检查容器网络和抖音登录/验证状态`, { cause });
  });
  if (!response.ok) {
    throw new Error(`抖音 IM 接口 https://imapi.douyin.com/${path} 返回 HTTP ${response.status}`);
  }
  return Buffer.from(response.body, 'base64');
}
