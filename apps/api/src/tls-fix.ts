import { X509Certificate } from 'node:crypto';
import tls from 'node:tls';

/**
 * Some servers (often government sites) send their certificate WITHOUT the intermediate certificate that links it to a trusted authority.
 * Browsers fetch the missing piece automatically; Node does not and fails with UNABLE_TO_VERIFY_LEAF_SIGNATURE. This downloads the intermediate from the address
 * the site's own certificate names, checks that it really is the issuer, and checks that the connection then verifies. Verification is never switched off.
 */
export type ChainFix = { status: 'no_fix_needed' } | { status: 'fixed'; intermediates: X509Certificate[]; root?: X509Certificate; pem: string };

const connect = (host: string, port: number, opts: tls.ConnectionOptions) => new Promise<tls.TLSSocket>((resolve, reject) => {
  const s = tls.connect({ host, port, servername: host, ...opts }, () => resolve(s));
  s.setTimeout(15_000, () => { s.destroy(); reject(new Error('timeout')); }); s.once('error', reject);
});
const aiaUrl = (c: X509Certificate) => /CA Issuers - URI:(\S+)/.exec(c.infoAccess ?? '')?.[1];

async function download(url: string): Promise<X509Certificate> {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Could not download ${url} (HTTP ${res.status}).`);
  const buf = Buffer.from(await res.arrayBuffer());
  try { return new X509Certificate(buf); } catch { /* maybe PEM text */ }
  try { return new X509Certificate(buf.toString('utf8')); } catch { throw new Error(`The certificate at ${url} is in a format this tool cannot read (for example PKCS#7). Export it from your browser instead.`); }
}

export async function fetchMissingChain(host: string, port = 443, o: { trustedRoots?: readonly string[]; includeRoot?: boolean } = {}): Promise<ChainFix> {
  const roots = [...(o.trustedRoots ?? tls.rootCertificates)];
  const verifyWith = async (extra: X509Certificate[]) => { try { (await connect(host, port, { ca: [...roots, ...extra.map((c) => c.toString())] })).end(); return null; } catch (e) { return (e as NodeJS.ErrnoException).code ?? (e as Error).message; } };
  const first = await verifyWith([]); if (first === null) return { status: 'no_fix_needed' };
  if (!['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY'].includes(first)) throw new Error(`The connection failed for a different reason (${first}). A missing certificate is not the cause.`);

  const s = await connect(host, port, { rejectUnauthorized: false });   // only to read the public certificate; nothing is sent over this connection
  let cur = new X509Certificate(s.getPeerCertificate(true).raw); s.end();
  const intermediates: X509Certificate[] = []; let root: X509Certificate | undefined;
  for (let i = 0; i < 4; i++) {
    const url = aiaUrl(cur);
    if (!url || !/^https?:\/\//.test(url)) throw new Error('The site certificate does not say where to download its issuer from, so this cannot be fixed automatically. Export the intermediate certificate from your browser instead.');
    const next = await download(url);
    if (!cur.checkIssued(next)) throw new Error(`The downloaded certificate (${next.subject}) is not the issuer of ${cur.subject}. Stopping.`);
    if (next.subject === next.issuer) { root = next; break; }   // self-signed: a root authority
    intermediates.push(next); cur = next;
    if ((await verifyWith(intermediates)) === null) break;
  }
  const chosen = o.includeRoot && root ? [...intermediates, root] : intermediates;
  const after = await verifyWith(chosen);
  if (after !== null) throw new Error(root && !o.includeRoot
    ? `The chain ends at a root authority that your Node does not trust: ${root.subject.replace(/\n/g, ', ')}. Trusting it means this app will accept certificates it issues. If you accept that, run again with --include-root.`
    : `Still failing after adding the missing certificate (${after}).`);
  return { status: 'fixed', intermediates, root: o.includeRoot ? root : undefined, pem: chosen.map((c) => c.toString()).join('') };
}
