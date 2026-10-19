import { Info } from 'lucide-react';
import type { Analytics } from '../lib/api';

export default function Overview({ a }: { a: Analytics | 'loading' }) {
  if (a === 'loading') return <p className="p-4 text-sm text-dim">Loading overview…</p>;
  if (!a.summary) return <div role="status" className="m-3 rounded-[6px] border border-line bg-bg2 p-3 text-sm">The analytics service is unavailable. No figures are shown.</div>;
  const s = a.summary, max = Math.max(1, ...(a.categories?.data.map((c) => c.incidents) ?? [1])), tmax = Math.max(1, ...(a.timeline?.data.map((t) => t.incidents) ?? [1]));
  const p = s.provenance.period;
  return <section aria-label="Overview of collected reports" className="space-y-4 p-4 text-sm">
    <div><h2 className="font-medium">Collected reports</h2>
      <p className="mt-1 text-dim">{s.provenance.description}. Period: {p.from || p.to ? `${p.from ?? 'earliest'} to ${p.to ?? 'latest'} (event date, IST)` : 'all dates'}.</p></div>
    <dl className="grid grid-cols-2 gap-3">
      <div className="rounded-[6px] border border-line p-3"><dt className="text-dim">Incidents</dt><dd className="text-2xl">{s.data.incidents}</dd></div>
      <div className="rounded-[6px] border border-line p-3"><dt className="text-dim">Linked source reports</dt><dd className="text-2xl">{s.data.sourceDocumentsLinked}</dd><dd className="text-xs text-dim">Reports, not crimes</dd></div>
    </dl>
    <p className="flex gap-2 text-dim"><Info size={16} className="mt-0.5 shrink-0" aria-hidden /> Official statistics: {s.officialStatistics.available ? 'available' : s.officialStatistics.note}</p>
    {a.categories && a.categories.data.length > 0 && <div><h3 className="font-medium">By category</h3><ul className="mt-2 space-y-1.5">
      {a.categories.data.map((c) => <li key={c.code}><div className="flex justify-between"><span>{c.label}</span><span>{c.incidents}</span></div>
        <div className="mt-0.5 h-1.5 rounded bg-bg2"><div className="h-1.5 rounded bg-dim" style={{ width: `${(c.incidents / max) * 100}%` }} /></div></li>)}</ul></div>}
    {a.timeline && a.timeline.data.length > 0 && <div><h3 className="font-medium">Per day (event date)</h3>
      <div className="mt-2 flex h-16 items-end gap-0.5" role="img" aria-label={`Incidents per day, ${a.timeline.data.length} days`}>
        {a.timeline.data.map((t) => <div key={t.bucket} title={`${t.bucket}: ${t.incidents}`} className="min-w-[3px] flex-1 bg-dim" style={{ height: `${(t.incidents / tmax) * 100}%` }} />)}</div>
      <p className="mt-1 text-xs text-dim">{a.timeline.data[0].bucket} to {a.timeline.data[a.timeline.data.length - 1].bucket}. {a.timeline.undatedIncidents} incidents have no stated event date and are not shown.</p></div>}
    <div><h3 className="font-medium">Read with care</h3><ul className="mt-1 list-disc space-y-1 pl-5 text-dim">{s.caveats.map((c) => <li key={c}>{c}</li>)}</ul></div>
  </section>;
}
