import { describe, expect, it } from 'vitest';
import { convertLegacyDevanagari as conv, looksLikeLegacyDevanagari, normalizeDocumentText } from './legacy-font';

// Test vectors are generic words taken from the real encoding seen in Nagpur Police press notes (no names or case details).
describe('legacy Marathi font conversion (Kruti Dev)', () => {
  it.each([
    ["ukxiwj 'kgj iksyhl vk;qDrky;", 'नागपूर शहर पोलीस आयुक्तालय'],
    ['fnukad 16-10-2026', 'दिनांक 16-10-2026'],
    ["xqUgs'kk[kk", 'गुन्हेशाखा'], ['vkjksih', 'आरोपी'], ['xqUgk nk[ky', 'गुन्हा दाखल'], ['iksyhl Bk.ks', 'पोलीस ठाणे'], ['dkjokbZ', 'कारवाई'], ['jksth', 'रोजी'], ['d:u', 'करून'],
    ['eqÌseky', 'मुद्देमाल'], ['dj.kkÚ;k', 'करणाऱ्या'], ['Jherh', 'श्रीमती'], ['fe=', 'मित्र'], ['izk.kkafrd', 'प्राणांतिक'], ['o"kZs', 'वर्षे'], ['ekxZn’kZu', 'मार्गदर्शन'], ['1]937 ¼ikp½', '1,937 (पाच)'],
  ])('%s', (input, expected) => expect(conv(input)).toBe(expected));
  it('leaves English acronyms and plain numbers alone', () => {
    expect(conv('NAGPUR CITY POLICE COMMISSIONERATE')).toBe('NAGPUR CITY POLICE COMMISSIONERATE'); expect(conv('MIDC iksyhl')).toBe('MIDC पोलीस');
  });
  it('detects legacy text without touching English or real Unicode Marathi', () => {
    expect(looksLikeLegacyDevanagari("ukxiwj 'kgj iksyhl fnukad 16-10-2026 xqUgk nk[ky vkjksih")).toBe(true);
    expect(looksLikeLegacyDevanagari('The police recorded a theft near the market on Friday.')).toBe(false);
    expect(looksLikeLegacyDevanagari('नागपूर शहर पोलीस आयुक्तालय दिनांक गुन्हा दाखल')).toBe(false);
  });
  it('normalises legacy text, and refuses a result that does not look like Marathi', () => {
    const ok = normalizeDocumentText("ukxiwj 'kgj iksyhl fnukad 16-10-2026 xqUgk nk[ky vkjksih dkjokbZ");
    expect(ok).toMatchObject({ legacy: true, converted: true }); expect(ok.text).toContain('पोलीस'); expect(ok.text).toContain('आरोपी');
    expect(normalizeDocumentText('iksyhl fnukad ukxiwj 1234567890123456789012345678901234567890')).toMatchObject({ legacy: true, converted: false });
    expect(normalizeDocumentText('Plain English press note text.')).toMatchObject({ legacy: false, converted: false });
  });
});
