export interface SourceItem {
  canonicalUrl: string; externalId: string | null; title: string; publishedAt: Date | null;
  language: string | null; bodyText: string | null;
  incidentBearing: boolean;  // false for notices, orders, etc.: stored for the record, never sent to extraction
}
export interface RunDeps { fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void>; now?: () => Date; maxAttempts?: number; baseDelayMs?: number }
export interface Connector { slug: string; fetchItems(deps: RunDeps): Promise<SourceItem[]> }
export class FetchError extends Error { constructor(message: string, public retryable: boolean) { super(message); this.name = 'FetchError'; } }
