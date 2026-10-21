import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fetchMissingChain } from './tls-fix';

const [host, ...flags] = process.argv.slice(2);
if (!host || /[/:\s]/.test(host)) { console.error('usage: npm run fix-tls -w "@crimelens/api" -- <hostname> [--include-root]\nexample: ... -- nagpurpolice.gov.in'); process.exit(1); }
try {
  const r = await fetchMissingChain(host, 443, { includeRoot: flags.includes('--include-root') });
  if (r.status === 'no_fix_needed') { console.log(`Node already trusts ${host}. The problem is something else; nothing was changed.`); process.exit(0); }
  const dir = fileURLToPath(new URL('../../../certs/', import.meta.url)); mkdirSync(dir, { recursive: true });
  const file = `${dir}${host}.pem`; writeFileSync(file, r.pem);
  for (const c of [...r.intermediates, ...(r.root ? [r.root] : [])]) console.log(`Saved certificate: ${c.subject.replace(/\n/g, ', ')}\n  fingerprint (SHA-256): ${c.fingerprint256}`);
  console.log(`\nWritten to ${file}\nVerified: connections to ${host} now succeed with this file.\n\nUse it (PowerShell):  $env:NODE_EXTRA_CA_CERTS = "${file}"\nUse it (bash):        export NODE_EXTRA_CA_CERTS="${file}"\nThen run your command from the same window.`);
} catch (e) { console.error((e as Error).message); process.exit(1); }
