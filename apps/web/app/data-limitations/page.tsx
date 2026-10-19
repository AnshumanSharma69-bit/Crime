import Link from 'next/link';
import { z } from 'zod';

export const dynamic = 'force-dynamic';
const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
const Registry = z.object({ items: z.array(z.object({ slug: z.string(), name: z.string(), type: z.string(), url: z.string(), collectionMethod: z.string(), parserStatus: z.string(), termsNotes: z.string() })) });

async function load() {
  try { const r = await fetch(`${API}/api/sources`, { cache: 'no-store' }); const p = Registry.safeParse(await r.json()); return r.ok && p.success ? p.data.items : null; } catch { return null; }
}
export const metadata = { title: 'Source coverage and data limitations · CrimeLens' };

export default async function Page() {
  const sources = await load();
  return <main className="mx-auto max-w-3xl space-y-6 p-6 text-sm leading-relaxed">
    <Link href="/" className="text-dim underline">← Back to the map</Link>
    <h1 className="font-headline text-2xl">Source coverage and data limitations</h1>
    <section className="space-y-2"><h2 className="text-lg font-medium">What CrimeLens is</h2>
      <p>CrimeLens collects incident reports published by police and news organisations and links each one to its original source. It is not an official police database and does not claim complete coverage.</p></section>
    <section className="space-y-2"><h2 className="text-lg font-medium">How to read the numbers</h2><ul className="list-disc space-y-1 pl-5">
      <li>Counts are collected reports, not crime rates. More reports can mean more coverage, not more crime.</li>
      <li>Reports, articles and incidents are different things. One incident can have several reports.</li>
      <li>Areas are never ranked. There is no population or reporting-rate denominator.</li>
      <li>A police statement confirms what police said. It does not prove every allegation, and an accused person is not presumed guilty.</li>
      <li>Marker positions can be approximate. Sensitive incidents are shown at neighbourhood level at most.</li>
      <li>Timestamps are stored in UTC and shown in IST. Sources publish at their own pace, so this is not a real-time feed.</li></ul></section>
    <section className="space-y-2"><h2 className="text-lg font-medium">Sources</h2>
      {sources === null ? <p role="status">The source registry is unavailable right now.</p> : <ul className="space-y-3">{sources.map((s) => <li key={s.slug} className="rounded-[6px] border border-line p-3">
        <p className="font-medium">{s.name}</p><p className="text-dim">{s.type} · {s.collectionMethod} · parser: {s.parserStatus.replace(/_/g, ' ')}</p>
        <p className="mt-1 text-dim">{s.termsNotes}</p></li>)}</ul>}
      <p className="text-dim">Live sync status appears in the map header. A source that has never run shows "never".</p></section>
    <section className="space-y-2"><h2 className="text-lg font-medium">Corrections</h2><p>Reviewers can correct, archive or remove records. Every change is recorded in an audit log. See docs/CORRECTIONS_AND_RETENTION.md in the repository for the procedure.</p></section>
  </main>;
}
