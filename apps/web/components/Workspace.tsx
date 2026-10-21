'use client';
import { useEffect, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { AlertTriangle, ArrowLeft, ExternalLink, Moon, PanelLeftClose, PanelLeftOpen, Search, Sun } from 'lucide-react';
import { CATEGORY_CODES, CATEGORY_LABELS, VERIFICATION_STATUSES, VERIFICATION_LABELS, formatIST, type IncidentDTOType } from '@crimelens/shared';
import { parseFilters, toQuery, type Filters } from '../lib/filters';
import Overview from './Overview';
import { fetchAnalytics, fetchIncidents, fetchSourceStatus, type Analytics, type Bbox } from '../lib/api';
import { toneOf, TONE_HEX } from '../lib/tone';

const MapView = dynamic(() => import('./MapView'), { ssr: false, loading: () => <div className="h-full bg-bg1" /> });
const NAGPUR: [number, number] = [79.0882, 21.1458];
type State = { status: 'loading' } | { status: 'unavailable' | 'invalid' } | { status: 'ok'; items: IncidentDTOType[]; total: number };
const field = 'w-full rounded-[6px] border border-line bg-bg2 px-2 py-1.5 text-sm text-ink';

function Badge({ i }: { i: IncidentDTOType }) {
  const c = TONE_HEX[toneOf(i)];
  return <span className="inline-flex items-center rounded-[4px] border px-1.5 py-0.5 text-xs" style={{ color: c, borderColor: c }}>
    {i.sourceType === 'official_police' ? 'Police' : 'News'} · {VERIFICATION_LABELS[i.verificationStatus]}</span>;
}

function Notice({ title, body }: { title: string; body: string }) {
  return <div role="status" className="m-3 rounded-[6px] border border-line bg-bg2 p-3 text-sm">
    <p className="flex items-center gap-2 font-medium"><AlertTriangle size={16} aria-hidden /> {title}</p><p className="mt-1 text-dim">{body}</p></div>;
}

function Detail({ i, onBack }: { i: IncidentDTOType; onBack: () => void }) {
  const approx = i.location && i.location.precision !== 'street';
  return <article className="p-4 text-sm">
    <button onClick={onBack} className="mb-3 flex items-center gap-1 text-dim hover:text-ink"><ArrowLeft size={14} aria-hidden /> Back to list</button>
    <h2 className="font-headline text-xl leading-snug">{i.headline}</h2>
    <div className="mt-2"><Badge i={i} /></div>
    <p className="mt-3 leading-relaxed">{i.summary}</p>
    <dl className="mt-4 grid grid-cols-[8rem_1fr] gap-y-1.5 text-dim">
      <dt>Category</dt><dd className="text-ink">{CATEGORY_LABELS[i.categoryCode]}</dd>
      <dt>Event date</dt><dd className="text-ink">{i.eventDate ? formatIST(i.eventDate) : 'Not stated'}</dd>
      <dt>Published</dt><dd className="text-ink">{formatIST(i.publishedAt)}</dd>
      <dt>Last updated</dt><dd className="text-ink">{formatIST(i.updatedAt)}</dd>
      <dt>Location</dt><dd className="text-ink">{i.locality ?? 'Place name not stated'}{i.location ? ` · ${i.location.precision.replace(/_/g, ' ')} position, ${i.location.confidence} confidence` : ' · not mapped'}</dd>
    </dl>
    {approx && <p className="mt-3 rounded-[6px] border border-line p-2 text-dim">The marker shows an approximate area, not the exact location of the incident.</p>}
    {i.verificationNote && <p className="mt-3 text-dim">{i.verificationNote}</p>}
    <p className="mt-3 text-dim">A police statement confirms what police reported. It does not prove every allegation.</p>
    <h3 className="mt-5 font-medium">Original sources</h3>
    <ul className="mt-1 space-y-1">{i.sources.map((s) => <li key={s.url}>
      <a className="inline-flex items-center gap-1 underline" href={s.url} target="_blank" rel="noopener noreferrer">{s.name} <ExternalLink size={12} aria-hidden /></a>
      {s.publishedAt && <span className="text-dim"> · {formatIST(s.publishedAt)}</span>}</li>)}</ul>
    {i.updates.length > 0 && <><h3 className="mt-5 font-medium">Developments and corrections</h3>
      <ol className="mt-1 space-y-2 border-l border-line pl-3">{i.updates.map((u, n) => <li key={n}>
        <span className="text-dim">{u.occurredAt ? formatIST(u.occurredAt) : 'Date unknown'} · {u.kind}</span><br />{u.summary}</li>)}</ol></>}
  </article>;
}

export default function Workspace() {
  const router = useRouter();
  const key = useSearchParams().toString();
  const filters = useMemo(() => parseFilters(new URLSearchParams(key)), [key]);
  const [q, setQ] = useState(filters.q ?? '');
  const [state, setState] = useState<State>({ status: 'loading' });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tab, setTab] = useState<'list' | 'overview'>('list');
  const [collapsed, setCollapsed] = useState(false);
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  useEffect(() => { try { const t = localStorage.getItem('crimelens-theme'); if (t === 'light' || t === 'dark') setTheme(t); else if (window.matchMedia?.('(prefers-color-scheme: light)').matches) setTheme('light'); } catch { /* storage unavailable */ } }, []);
  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);
  const toggleTheme = () => { const n = theme === 'dark' ? 'light' : 'dark'; setTheme(n); try { localStorage.setItem('crimelens-theme', n); } catch { /* ignore */ } };
  const [bounds, setBounds] = useState<Bbox | null>(null);
  const [inView, setInView] = useState(false);
  const [analytics, setAnalytics] = useState<Analytics | 'loading'>('loading');
  const [sources, setSources] = useState<{ slug: string; status: string; lastSuccessAt: string | null }[] | null | 'loading'>('loading');
  const bbox = inView ? bounds : null; const bboxKey = bbox?.join(',') ?? '';
  const setFilter = (patch: Partial<Filters>) => router.replace(`?${toQuery({ ...filters, ...patch })}`, { scroll: false });

  useEffect(() => {  // debounced search -> URL
    const t = setTimeout(() => { if ((filters.q ?? '') !== q.trim()) setFilter({ q: q.trim() || undefined }); }, 350);
    return () => clearTimeout(t);
  }, [q]);
  useEffect(() => {
    const ac = new AbortController();
    setState({ status: 'loading' });
    fetchIncidents('nagpur', filters, ac.signal, bbox).then((r) => {
      if (!ac.signal.aborted) setState(r.ok ? { status: 'ok', ...r.data } : { status: r.reason });
    });
    return () => ac.abort();
  }, [filters, bboxKey]);
  useEffect(() => {
    if (tab !== 'overview') return;
    const ac = new AbortController(); setAnalytics('loading');
    fetchAnalytics('nagpur', filters, bbox, ac.signal).then((a) => { if (!ac.signal.aborted) setAnalytics(a); });
    return () => ac.abort();
  }, [tab, filters, bboxKey]);
  useEffect(() => { const ac = new AbortController(); fetchSourceStatus(ac.signal).then((r) => { if (!ac.signal.aborted) setSources(r ? r.items : null); }); return () => ac.abort(); }, []);
  const fixtureLoaded = Array.isArray(sources) && sources.some((x) => x.slug.startsWith('dev-fixture'));
  const realSources = Array.isArray(sources) ? sources.filter((x) => !x.slug.startsWith('dev-fixture')) : sources;   // fake fixture sources are not counted
  const lastSync = Array.isArray(realSources) ? realSources.map((x) => x.lastSuccessAt).filter(Boolean).sort().pop() : null;

  const items = state.status === 'ok' ? state.items : [];
  const selected = items.find((i) => i.id === selectedId) ?? null;
  const filtered = Object.values(filters).some(Boolean);

  return <div className="flex h-screen flex-col bg-bg0 text-ink">
    <header className="flex flex-wrap items-center gap-3 border-b border-line bg-bg1 px-4 py-2">
      <span className="font-headline text-lg">CrimeLens</span>
      <Link href="/data-limitations" className="text-xs text-dim underline">Data limitations</Link>
      <select aria-label="City" className={`${field} !w-auto`} defaultValue="nagpur"><option value="nagpur">Nagpur, Maharashtra</option></select>
      <label className="relative min-w-[12rem] flex-1 md:max-w-sm"><Search size={14} className="absolute left-2 top-2.5 text-dim" aria-hidden />
        <input aria-label="Search incidents" className={`${field} pl-7`} placeholder="Search headlines and localities" value={q} onChange={(e) => setQ(e.target.value)} /></label>
      <button aria-label={collapsed ? 'Show side panel' : 'Hide side panel'} className={`${field} !w-auto`} onClick={() => setCollapsed((c) => !c)}>{collapsed ? <PanelLeftOpen size={16} aria-hidden /> : <PanelLeftClose size={16} aria-hidden />}</button>
      <button aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'} className={`${field} !w-auto`} onClick={toggleTheme}>{theme === 'dark' ? <Sun size={16} aria-hidden /> : <Moon size={16} aria-hidden />}</button>
      <span className="ml-auto text-xs text-dim">Incident service: {state.status === 'ok' ? 'reachable' : state.status === 'loading' ? 'checking…' : 'unavailable'} · Sources connected: {Array.isArray(realSources) ? `${realSources.filter((x) => x.status === 'connected').length} of ${realSources.length}` : realSources === 'loading' ? '…' : 'unknown'} · Last successful sync: {Array.isArray(realSources) ? (lastSync ? formatIST(lastSync) : 'never') : 'unknown'}</span>
    </header>
    {fixtureLoaded && <div role="status" className="border-b border-line px-4 py-1.5 text-xs" style={{ background: '#3a2f12', color: '#e0a43a' }}>Development fixture data is loaded. The incidents shown are fake. Remove them with <code>npm run seed:dev:remove</code>.</div>}
    <main className="flex min-h-0 flex-1 flex-col md:flex-row">
      <aside className={`${collapsed ? 'hidden ' : ''}flex max-h-[55vh] w-full flex-col border-b border-line bg-bg1 md:max-h-none md:w-[380px] md:border-b-0 md:border-r`}>
        {selected ? <div className="overflow-y-auto"><Detail i={selected} onBack={() => setSelectedId(null)} /></div> : <>
          <div className="grid grid-cols-2 gap-2 border-b border-line p-3">
            <select aria-label="Category" className={field} value={filters.category ?? ''} onChange={(e) => setFilter({ category: (e.target.value || undefined) as Filters['category'] })}>
              <option value="">All categories</option>{CATEGORY_CODES.map((c) => <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>)}</select>
            <select aria-label="Verification status" className={field} value={filters.verification ?? ''} onChange={(e) => setFilter({ verification: (e.target.value || undefined) as Filters['verification'] })}>
              <option value="">Any verification</option>{VERIFICATION_STATUSES.map((v) => <option key={v} value={v}>{VERIFICATION_LABELS[v]}</option>)}</select>
            <select aria-label="Source type" className={field} value={filters.sourceType ?? ''} onChange={(e) => setFilter({ sourceType: (e.target.value || undefined) as Filters['sourceType'] })}>
              <option value="">Police and news</option><option value="official_police">Police</option><option value="news">News</option></select>
            <button className={`${field} text-left text-dim disabled:opacity-40`} disabled={!filtered} onClick={() => { setQ(''); router.replace('?'); }}>Clear filters</button>
            <input aria-label="Event date from" type="date" className={field} value={filters.from ?? ''} onChange={(e) => setFilter({ from: e.target.value || undefined })} />
            <input aria-label="Event date to" type="date" className={field} value={filters.to ?? ''} onChange={(e) => setFilter({ to: e.target.value || undefined })} />
          </div>
          <div className="flex items-center gap-2 border-b border-line px-3 py-2 text-sm">
            {(['list', 'overview'] as const).map((t) => <button key={t} aria-pressed={tab === t} onClick={() => setTab(t)} className={`rounded-[6px] px-2 py-1 ${tab === t ? 'bg-bg2 text-ink' : 'text-dim hover:text-ink'}`}>{t === 'list' ? 'Incidents' : 'Overview'}</button>)}
            <label className="ml-auto flex items-center gap-1 text-xs text-dim"><input type="checkbox" checked={inView} onChange={(e) => setInView(e.target.checked)} /> Only this map view</label>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {tab === 'overview' && <Overview a={analytics} />}
            {tab === 'list' && <>
            {state.status === 'loading' && <p className="p-4 text-sm text-dim">Loading incidents…</p>}
            {state.status === 'unavailable' && <Notice title="The incident service is unavailable" body="No data is shown because the API could not be reached. Nothing here is sample data." />}
            {state.status === 'invalid' && <Notice title="The incident service returned unexpected data" body="The response failed validation, so it was not displayed." />}
            {state.status === 'ok' && items.length === 0 && (filtered
              ? <Notice title="No incidents match these filters" body="Widen the date range or clear a filter. An empty result does not mean nothing happened; coverage is limited to collected sources." />
              : <Notice title="No incidents have been collected yet" body="Source connectors are not active, so the map is empty. CrimeLens never fills it with placeholder records." />)}
            <ul>{items.map((i) => <li key={i.id} className="border-b border-line">
              <button className={`w-full p-3 text-left hover:bg-bg2 ${i.id === selectedId ? 'bg-bg2' : ''}`} onClick={() => setSelectedId(i.id)}>
                <span className="font-headline block leading-snug">{i.headline}</span>
                <span className="mt-1 block text-xs text-dim">{CATEGORY_LABELS[i.categoryCode]} · {i.locality ?? 'Locality unknown'} · {formatIST(i.publishedAt)}</span>
                <span className="mt-1.5 block"><Badge i={i} /></span></button></li>)}</ul></>}
          </div>
          <p className="border-t border-line p-3 text-xs text-dim">Incidents are collected from police and news reports. CrimeLens is not an official police database and coverage is incomplete. Report counts are not crime rates.</p>
        </>}
      </aside>
      <section className="relative min-h-[40vh] flex-1">
        <MapView items={items} selectedId={selected?.id ?? null} onSelect={setSelectedId} center={NAGPUR} onBounds={setBounds} theme={theme} />
        <div className="absolute bottom-6 left-3 rounded-[6px] border border-line bg-bg1 p-2 text-xs text-ink shadow-lg">
          {(['official', 'news', 'corroborated', 'disputed'] as const).map((t) => <div key={t} className="flex items-center gap-2">
            <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: TONE_HEX[t] }} />{{ official: 'Police report', news: 'News report', corroborated: 'Multiple sources', disputed: 'Disputed or corrected' }[t]}</div>)}
          <div className="mt-1 border-t border-line pt-1">Faint ring: approximate area</div>
        </div>
      </section>
    </main>
  </div>;
}
