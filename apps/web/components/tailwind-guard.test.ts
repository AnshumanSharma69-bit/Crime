import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Tailwind silently drops opacity suffixes on colours defined as CSS variables (bg-bg1/95 produces no CSS at all), which once left the map legend transparent.
const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : f.endsWith('.tsx') ? [join(d, f)] : []));
describe('Tailwind usage', () => {
  it('never puts an opacity suffix on a theme colour', () => {
    const bad = ['components', 'app'].flatMap(walk).flatMap((f) => (readFileSync(f, 'utf8').match(/\b(bg|text|border|ring|divide|shadow)-(bg0|bg1|bg2|line|dim|ink)\/\d+/g) ?? []).map((m) => `${f}: ${m}`));
    expect(bad).toEqual([]);
  });
});
