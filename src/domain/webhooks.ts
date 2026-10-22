import dns from 'node:dns';
import https from 'node:https';
import net, { BlockList } from 'node:net';
import { AppError } from './errors.ts';
import { signPayload } from './crypto.ts';

const block = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
  ['100.64.0.0', 10],
] as const) {
  block.addSubnet(network, prefix, 'ipv4');
}
block.addAddress('255.255.255.255', 'ipv4');
block.addAddress('::1', 'ipv6');
block.addAddress('::', 'ipv6');
block.addSubnet('fc00::', 7, 'ipv6');
block.addSubnet('fe80::', 10, 'ipv6');
block.addSubnet('ff00::', 8, 'ipv6');

export function isUnsafeIp(address: string): boolean {
  const ip = address.split('%')[0] ?? address;
  const family = net.isIP(ip);
  if (family === 0) return true;
  if (block.check(ip, family === 4 ? 'ipv4' : 'ipv6')) return true;
  const mapped = ip.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped?.[1] && block.check(mapped[1], 'ipv4')) return true;
  return false;
}

function blockedHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    return true;
  }
  if (host === 'metadata.google.internal' || host === 'metadata.internal') return true;
  if (/^\d+$/.test(host)) return true;
  return false;
}

export type DnsLookup = (hostname: string) => Promise<string[]>;

export async function defaultLookup(hostname: string): Promise<string[]> {
  const records = await dns.promises.lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => record.address);
}

export async function validateWebhookDestination(
  raw: string,
  lookup: DnsLookup = defaultLookup,
): Promise<{ hostname: string; addresses: string[] }> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AppError(400, 'unsafe_destination', 'Webhook URL is invalid');
  }
  if (url.protocol !== 'https:') throw new AppError(400, 'unsafe_destination', 'Webhook URL must use https');
  if (url.username || url.password) throw new AppError(400, 'unsafe_destination', 'Webhook URL cannot include credentials');
  if (url.port && url.port !== '443') throw new AppError(400, 'unsafe_destination', 'Webhook URL must use port 443');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (!hostname || blockedHostname(hostname)) {
    throw new AppError(400, 'unsafe_destination', 'Webhook host is not allowed');
  }
  const addresses = net.isIP(hostname) ? [hostname] : await lookup(hostname).catch(() => []);
  if (addresses.length === 0) throw new AppError(400, 'unsafe_destination', 'Webhook host did not resolve');
  for (const address of addresses) {
    if (isUnsafeIp(address)) throw new AppError(400, 'unsafe_destination', 'Webhook host resolves to a blocked address');
  }
  return { hostname, addresses };
}

export type SignedRequest = {
  url: string;
  body: string;
  headers: Record<string, string>;
};

export type Transport = (request: SignedRequest) => Promise<{ status: number }>;

export function webhookHeaders(secret: string, eventId: string, rawBody: string, now: Date): Record<string, string> {
  const timestamp = Math.floor(now.getTime() / 1000).toString();
  return {
    'content-type': 'application/json',
    'webhook-id': eventId,
    'webhook-timestamp': timestamp,
    'webhook-signature': `v1=${signPayload(secret, timestamp, rawBody)}`,
    'user-agent': 'marlow-civic-cms',
  };
}

export async function defaultTransport(request: SignedRequest): Promise<{ status: number }> {
  await validateWebhookDestination(request.url);
  const url = new URL(request.url);
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        method: 'POST',
        protocol: 'https:',
        hostname: url.hostname,
        port: 443,
        path: `${url.pathname}${url.search}`,
        headers: {
          ...request.headers,
          'content-length': Buffer.byteLength(request.body),
        },
        timeout: 5000,
        lookup: (hostname, options, callback) => {
          dns.lookup(hostname, { all: true }, (error, addresses) => {
            if (error) {
              callback(error, '', 4);
              return;
            }
            const list = Array.isArray(addresses) ? addresses : [];
            if (list.length === 0 || list.some((item) => isUnsafeIp(item.address))) {
              callback(new Error('unsafe address'), '', 4);
              return;
            }
            const picked = list[0];
            if (!picked) {
              callback(new Error('no address'), '', 4);
              return;
            }
            if (options.all) {
              callback(null, list as unknown as string, picked.family);
              return;
            }
            callback(null, picked.address, picked.family);
          });
        },
      },
      (res) => {
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 65_536) res.destroy();
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0 }));
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(request.body);
  });
}

export function publicationEventPayload(input: {
  eventId: string;
  createdAt: string;
  publicationId: string;
  entryId: string;
  revisionId: string;
  site: string;
  locale: string;
  slug: string;
  eventType: string;
}): string {
  return JSON.stringify({
    id: input.eventId,
    type: 'entry.published',
    createdAt: input.createdAt,
    data: {
      publicationId: input.publicationId,
      entryId: input.entryId,
      revisionId: input.revisionId,
      site: input.site,
      locale: input.locale,
      slug: input.slug,
      eventType: input.eventType,
    },
  });
}
