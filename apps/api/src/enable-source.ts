import { makePool } from './db';
const [slug, flag] = process.argv.slice(2);
if (!slug || flag !== '--reviewed-robots-and-terms') { console.error('usage: source:enable <slug> --reviewed-robots-and-terms   (only after reading the site robots.txt and terms)'); process.exit(1); }
const pool = makePool();
const r = await pool.query('UPDATE sources SET enabled = true, robots_checked_at = now() WHERE slug = $1', [slug]);
console.log(r.rowCount ? `enabled ${slug}` : 'no such source'); await pool.end();
