import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fetchMissingChain } from './tls-fix';

// Needs the openssl command line tool to build a throwaway certificate chain; skipped (not failed) where it is not installed.
const hasOpenssl = (() => { try { execFileSync('openssl', ['version'], { stdio: 'pipe' }); return true; } catch { return false; } })();
const listen = (s: http.Server | https.Server) => new Promise<number>((r) => s.listen(0, '127.0.0.1', () => r((s.address() as AddressInfo).port)));

describe.skipIf(!hasOpenssl)('fixing a server that omits its intermediate certificate', () => {
  let dir: string; let aia: http.Server; let leafOnly: https.Server; let fullChain: https.Server; let rootPem: string; let intPem: string;
  let leafOnlyPort = 0, fullPort = 0, aiaPort = 0;
  const sh = (a: string[]) => execFileSync('openssl', a, { cwd: dir, stdio: 'pipe' });
  const rd = (f: string) => readFileSync(join(dir, f), 'utf8');

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'tlsfix-'));
    aia = http.createServer((_q, r) => r.end(readFileSync(join(dir, 'int.cer')))); aiaPort = await listen(aia);
    sh(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'root.key', '-out', 'root.pem', '-subj', '/CN=Test Root', '-days', '2', '-addext', 'basicConstraints=critical,CA:TRUE']);
    sh(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'int.key', '-out', 'int.csr', '-subj', '/CN=Test Intermediate']);
    writeFileSync(join(dir, 'int.ext'), 'basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n');
    sh(['x509', '-req', '-in', 'int.csr', '-CA', 'root.pem', '-CAkey', 'root.key', '-CAcreateserial', '-out', 'int.pem', '-days', '2', '-extfile', 'int.ext']);
    sh(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'leaf.key', '-out', 'leaf.csr', '-subj', '/CN=localhost']);
    writeFileSync(join(dir, 'leaf.ext'), `subjectAltName=DNS:localhost\nauthorityInfoAccess=caIssuers;URI:http://127.0.0.1:${aiaPort}/int.cer\n`);
    sh(['x509', '-req', '-in', 'leaf.csr', '-CA', 'int.pem', '-CAkey', 'int.key', '-CAcreateserial', '-out', 'leaf.pem', '-days', '2', '-extfile', 'leaf.ext']);
    sh(['x509', '-in', 'int.pem', '-outform', 'DER', '-out', 'int.cer']);
    rootPem = rd('root.pem'); intPem = rd('int.pem');
    leafOnly = https.createServer({ key: rd('leaf.key'), cert: rd('leaf.pem') }); leafOnlyPort = await listen(leafOnly);                 // the broken server: leaf only
    fullChain = https.createServer({ key: rd('leaf.key'), cert: rd('leaf.pem') + intPem }); fullPort = await listen(fullChain);        // a correct server
  });
  afterAll(() => { aia.close(); leafOnly.close(); fullChain.close(); });

  it('reproduces the failure, downloads the intermediate named in the certificate, and verifies the result', async () => {
    const r = await fetchMissingChain('localhost', leafOnlyPort, { trustedRoots: [rootPem] });
    expect(r.status).toBe('fixed');
    if (r.status === 'fixed') { expect(r.intermediates).toHaveLength(1); expect(r.intermediates[0].fingerprint256).toBe(new X509Certificate(intPem).fingerprint256); expect(r.root).toBeUndefined(); expect(r.pem).toContain('BEGIN CERTIFICATE'); }
  });
  it('says nothing needs fixing when the server already sends a complete chain', async () => {
    expect(await fetchMissingChain('localhost', fullPort, { trustedRoots: [rootPem] })).toEqual({ status: 'no_fix_needed' });
  });
  it('refuses to guess when the failure has a different cause', async () => {
    const dead = http.createServer(); const port = await listen(dead); dead.close();   // a port with nothing listening
    await expect(fetchMissingChain('localhost', port, { trustedRoots: [rootPem] })).rejects.toThrow(/different reason/);
  });
  it('does not pretend to fix a server whose chain cannot be completed', async () => {
    aia.close(); await new Promise((r) => setTimeout(r, 50));   // the download address stops answering
    await expect(fetchMissingChain('localhost', leafOnlyPort, { trustedRoots: [rootPem] })).rejects.toThrow();
  });
});
