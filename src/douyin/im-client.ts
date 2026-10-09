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
  }, { path, body: body.toString('base64'), timeoutMs });
  if (!response.ok) {
    throw new Error(`Douyin ${path} HTTP failed: ${response.status}`);
  }
  return Buffer.from(response.body, 'base64');
}
