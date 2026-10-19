import type { IncidentDTOType } from '@crimelens/shared';
export type Tone = 'official' | 'news' | 'corroborated' | 'disputed';
export const TONE_HEX: Record<Tone, string> = { official: '#4c9aff', news: '#e0a43a', corroborated: '#4fb286', disputed: '#d95b57' };
export function toneOf(i: Pick<IncidentDTOType, 'verificationStatus' | 'sourceType'>): Tone {
  if (i.verificationStatus === 'disputed' || i.verificationStatus === 'corrected') return 'disputed';
  if (i.verificationStatus === 'corroborated') return 'corroborated';
  return i.sourceType === 'official_police' ? 'official' : 'news';
}
