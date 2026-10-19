/**
 * Many Indian government PDFs store Marathi/Hindi in legacy font encodings (here: Kruti Dev) instead of Unicode, so extracted text looks like
 * Latin gibberish ("iksyhl" is "पोलीस"). This converts it. The mapping covers the characters seen in real Nagpur Police press notes plus the standard
 * Kruti Dev set, but it is NOT exhaustive: unmapped characters pass through unchanged, and callers must treat a poor result as a failure.
 */
const MAP: Record<string, string> = {
  vkW: 'ऑ', vkS: 'औ', vks: 'ओ', vk: 'आ', va: 'अं', v: 'अ', bZ: 'ई', b: 'इ', m: 'उ', 'Å': 'ऊ', _: 'ऋ', ',s': 'ऐ', ',': 'ए',
  kS: 'ौ', ks: 'ो', k: 'ा', h: 'ी', q: 'ु', w: 'ू', s: 'े', S: 'ै', a: 'ं', '¡': 'ँ', W: 'ॉ', '~': '्', '%': ':',
  d: 'क', '[k': 'ख', x: 'ग', '?k': 'घ', p: 'च', N: 'छ', t: 'ज', '>': 'झ', V: 'ट', B: 'ठ', M: 'ड', '<': 'ढ', '.k': 'ण', r: 'त', Fk: 'थ', n: 'द', '/k': 'ध', u: 'न', i: 'प',
  Q: 'फ', c: 'ब', Hk: 'भ', e: 'म', ';': 'य', j: 'र', y: 'ल', o: 'व', "'k": 'श', '"k': 'ष', l: 'स', g: 'ह', '{k': 'क्ष', K: 'ज्ञ', '=': 'त्र', J: 'श्र',
  D: 'क्', '[': 'ख्', X: 'ग्', '?': 'घ्', P: 'च्', T: 'ज्', U: 'न्', F: 'थ्', '/': 'ध्', E: 'म्', I: 'प्', C: 'ब्', H: 'भ्', L: 'स्', R: 'त्', Y: 'ल्', O: 'व्', "'": 'श्', '"': 'ष्',
  z: '्र', 'ª': '्र', 'Ø': 'क्र', 'Ú': 'ऱ्', 'Ì': 'द्द', 'í': 'द्द',
  '¼': '(', '½': ')', ']': ',', '@': '/', '&': '-', ':': 'रू', '#': 'रु', f: 'ि', Z: '\uE000',   // \uE000 = reph, moved in front of its cluster below
};
const KEYS = Object.keys(MAP).sort((a, b) => b.length - a.length);
const C = '\u0915-\u0939\u0958-\u095F';
const MATRAS = '\u093E-\u094C\u093F\u0901-\u0903';
const PRE_I = new RegExp(`ि((?:[${C}]्)*[${C}])`, 'g'), REPH = new RegExp(`((?:[${C}]्)*[${C}])([${MATRAS}]*)\uE000`, 'g');

function convertToken(t: string): string {
  let out = '';
  for (let i = 0; i < t.length;) {
    const k = KEYS.find((key) => t.startsWith(key, i));
    if (k) { out += MAP[k]; i += k.length; } else { out += t[i]; i++; }
  }
  return out;
}
export function convertLegacyDevanagari(text: string): string {
  const s = text.replace(/\u2019/g, "'").split(/(\s+)/).map((t) => (/^[A-Z]{2,}[.,;:)]*$/.test(t) ? t : convertToken(t))).join('');   // all-capital words are English acronyms
  return s.replace(PRE_I, '$1ि').replace(REPH, 'र्$1$2').replace(/\uE000/g, 'र्');
}

export const devanagariShare = (t: string) => (t.match(/[\u0900-\u097F]/g)?.length ?? 0) / Math.max(1, t.replace(/\s/g, '').length);
const SIGNATURES = ['iksyhl', 'vkjksih', 'xqUg', 'dkjokbZ', 'fnukad', 'ukxiwj', 'dye', 'vVd', 'rikl'];   // very common words, as typed in this encoding
export const looksLikeLegacyDevanagari = (t: string) => devanagariShare(t) < 0.2 && SIGNATURES.filter((s) => t.includes(s)).length >= 3;

/** legacy = it looked like legacy-encoded text; converted = it was turned into Unicode with a plausible result. legacy && !converted means unusable. */
export function normalizeDocumentText(text: string): { text: string; legacy: boolean; converted: boolean } {
  if (!looksLikeLegacyDevanagari(text)) return { text, legacy: false, converted: false };
  const out = convertLegacyDevanagari(text);
  return devanagariShare(out) > 0.5 ? { text: out, legacy: true, converted: true } : { text, legacy: true, converted: false };
}
