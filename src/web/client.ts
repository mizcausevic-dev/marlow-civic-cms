export type CmsResponse = { status: number; body: string; contentType: string };

function assertPublicPath(path: string): void {
  if (path.startsWith('/api/public/') || path.startsWith('/media/')) return;
  throw new Error('The public frontend cannot request that CMS path');
}

export async function cmsGet(origin: string, path: string): Promise<CmsResponse> {
  assertPublicPath(path);
  const url = new URL(path, origin);
  if (url.origin !== new URL(origin).origin) throw new Error('The public frontend cannot change origin');
  const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
  const body = await response.text();
  return { status: response.status, body, contentType: response.headers.get('content-type') ?? '' };
}
