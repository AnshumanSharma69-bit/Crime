/**
 * Data minimisation before any text leaves this machine for an external AI service. Press notes name accused persons and complainants and give home addresses;
 * this removes, as far as simple patterns can: phone/ID/account-like numbers, vehicle registration numbers, e-mail addresses, the names that follow "नामे" ("named")
 * or an honorific, and the address that follows "रा." ("resident of"). It is pattern-based and WILL miss things, so inspect `npm run preview:extraction -w "@crimelens/api"` output on real notes.
 */
export type Redaction = { text: string; counts: { names: number; addresses: number; numbers: number; vehicles: number; emails: number } };

const NAME_MARKERS = new Set(['नामे']);
const HONORIFICS = new Set(['श्री.', 'श्री', 'श्रीमती', 'सौ.', 'सौ', 'कु.', 'कुमारी']);
const NAME_STOP = new Set(['वय', 'वर्ष', 'वर्षे', 'रा.', 'रा-', 'रा', 'राहणार', 'वर', 'व', 'आणि', 'यास', 'यांस', 'यांना', 'याला', 'याने', 'त्याने', 'त्याला', 'यांनी', 'यांच्या', 'याच्या', 'यांचे', 'यांचा', 'यांची', 'ने', 'तसेच']);
// Older converted text has "रा-" (Kruti Dev's hyphen key is a full stop); newer text has "रा.". Both are covered.
const ADDR_MARKERS = new Set(['रा.', 'रा-', 'राह.', 'राह-', 'राहणार', 'राहणारे', 'रहिवासी', 'निवासी', 'R/o', 'r/o']);
const ADDR_STOP = new Set(['यास', 'यांस', 'यांना', 'याला', 'यांनी', 'यांच्या', 'याच्या', 'त्यास', 'त्यांना', 'ताब्यात', 'अटक', 'यांच्याकडून', 'याच्याकडून']);
const clean = (w: string) => w.replace(/[,;:]+$/, '');
// Deliberately permissive: any word without digits counts as part of a name, so a name containing an unconverted stray character is still removed (over-redaction is the safe error).
const nameLike = (w: string) => clean(w).length > 0 && !/[0-9\u0966-\u096F]/.test(w);

export function redactForExternalApi(input: string): Redaction {
  const counts = { names: 0, addresses: 0, numbers: 0, vehicles: 0, emails: 0 };
  const sub = (re: RegExp, label: string, key: keyof typeof counts) => (t: string) => t.replace(re, () => { counts[key]++; return label; });
  let t = [
    sub(/(?<![\d])\d{4}[\s-]\d{4}[\s-]\d{4}(?![\d])/g, '[ID]', 'numbers'),
    sub(/\b[A-Z]{2}[\s.-]?\d{1,2}[\s.-]?[A-Z]{1,3}[\s.-]?\d{3,4}\b/g, '[VEHICLE-NO]', 'vehicles'),
    sub(/एम\.?\s?एच\.?[\s.-]*[0-9\u0966-\u096F]{1,2}[\s.-]*[\u0900-\u097F.]{1,8}[\s.-]*[0-9\u0966-\u096F]{3,4}/g, '[VEHICLE-NO]', 'vehicles'),
    sub(/(?<![\d,/])\d{8,}(?![\d,/])/g, '[NUMBER]', 'numbers'),   // amounts such as 81,570/- and case numbers such as 1234/2026 are untouched
    sub(/[\u0966-\u096F]{8,}/g, '[NUMBER]', 'numbers'),
    sub(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[EMAIL]', 'emails'),
  ].reduce((acc, f) => f(acc), input);

  const parts = t.split(/(\s+)/);   // words at even indexes, whitespace at odd
  const take = (from: number, max: number, ok: (w: string) => boolean, stop: Set<string>): number[] => {
    const idx: number[] = [];
    for (let j = from; j < parts.length && idx.length < max; j += 2) {
      const w = parts[j]; if (!w || stop.has(clean(w)) || !ok(w)) break;
      if (j > from && parts[j - 1].includes('\n')) break;   // never run past a line break
      idx.push(j); if (/[,।]$/.test(w)) break;
    }
    return idx;
  };
  const blank = (idx: number[], label: string) => { const comma = /,$/.test(parts[idx[idx.length - 1]]) ? ',' : ''; idx.forEach((k, n) => { parts[k] = n === 0 ? label + comma : ''; if (n > 0) parts[k - 1] = ''; }); };
  for (let i = 0; i < parts.length; i += 2) {
    const w = clean(parts[i] ?? '');
    if (NAME_MARKERS.has(w) || HONORIFICS.has(w)) {
      let s = i + 2; while (s < parts.length && HONORIFICS.has(clean(parts[s]))) s += 2;
      const idx = take(s, 4, nameLike, NAME_STOP); if (idx.length) { blank(idx, '[NAME]'); counts.names++; }
    } else if (ADDR_MARKERS.has(w)) {
      const idx = take(i + 2, 12, () => true, ADDR_STOP); if (idx.length) { blank(idx, '[ADDRESS]'); counts.addresses++; }
    }
  }
  return { text: parts.join(''), counts };
}
