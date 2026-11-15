import { describe, expect, it } from 'vitest';
import { redactForExternalApi as r } from './redact';

// Synthetic sentences in the usual police-note phrasing; none of these people exist.
describe('redaction before external AI calls', () => {
  it('removes the accused name and the address, keeping the rest of the sentence', () => {
    const out = r('आरोपी नामे राहुल सुरेश पाटील वय 25 वर्ष रा. प्लॉट नं 12 गांधीनगर नागपूर यास ताब्यात घेतले.');
    expect(out.text).toBe('आरोपी नामे [NAME] वय 25 वर्ष रा. [ADDRESS] यास ताब्यात घेतले.');
    expect(out.counts).toMatchObject({ names: 1, addresses: 1 });
  });
  it('also catches the address after "रा-", the form the older converter produced', () => {
    expect(r('आरोपी नामे राहुल सुरेश पाटील वय 25 वर्ष रा- प्लॉट नं 12 गांधीनगर नागपूर यास ताब्यात घेतले.').text).toBe('आरोपी नामे [NAME] वय 25 वर्ष रा- [ADDRESS] यास ताब्यात घेतले.');
    expect(r('इसम रा- गांधीनगर नागपूर यांना पकडले').text).toBe('इसम रा- [ADDRESS] यांना पकडले');
  });
  it('removes a name that contains a stray unconverted character, and stops at ordinary verbs', () => {
    expect(r('नामे राहुल@ पाटील वय 25').text).toBe('नामे [NAME] वय 25');
    expect(r('नामे राहुल याने चोरी केली').text).toBe('नामे [NAME] याने चोरी केली');
  });
  it('removes names after an honorific', () => expect(r('फिर्यादी श्री. रमेश गणपत देशमुख यांनी तक्रार दिली').text).toBe('फिर्यादी श्री. [NAME] यांनी तक्रार दिली'));
  it('removes phone, ID and vehicle numbers and e-mail, but keeps amounts and case numbers', () => {
    expect(r('मोबाईल क्रमांक 9876543210 व रक्कम 81,570/- रुपये गुन्हा क्र. 1234/2026').text).toBe('मोबाईल क्रमांक [NUMBER] व रक्कम 81,570/- रुपये गुन्हा क्र. 1234/2026');
    expect(r('आधार 1234 5678 9012').text).toBe('आधार [ID]');
    expect(r('दुचाकी MH 31 AB 1234 आणि MH31CD9876 चोरी').text).toBe('दुचाकी [VEHICLE-NO] आणि [VEHICLE-NO] चोरी');
    expect(r('write to someone@example.org now').text).toBe('write to [EMAIL] now');
  });
  it('never runs past a line break, never replaces more than a few name words, and leaves plain text alone', () => {
    expect(r('नामे राहुल\nवय 25').text).toBe('नामे [NAME]\nवय 25');
    expect(r('नामे एक दोन तीन चार पाच सहा').text).toBe('नामे [NAME] पाच सहा');
    expect(r('नामे 12345').text).toBe('नामे 12345');
    expect(r('A two-wheeler was reported stolen near the market.').text).toBe('A two-wheeler was reported stolen near the market.');
  });
  it('is idempotent', () => { const once = r('आरोपी नामे राहुल सुरेश पाटील वय 25 वर्ष रा. गांधीनगर नागपूर यास ताब्यात').text; expect(r(once).text).toBe(once); });
});
