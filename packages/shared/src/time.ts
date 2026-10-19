const IST_OFFSET_MIN = 330;

/** Internal storage is UTC; display is Asia/Kolkata. */
export function formatIST(value: Date | string): string {
  return new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

/** Parses the dd/mm/yyyy dates used on the Nagpur Police listing as midnight IST. Returns null if invalid. */
export function parseDmyAsIst(text: string): Date | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text.trim());
  if (!m) return null;
  const [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const utc = new Date(Date.UTC(y, mo - 1, d));
  if (utc.getUTCFullYear() !== y || utc.getUTCMonth() !== mo - 1 || utc.getUTCDate() !== d) return null;
  return new Date(utc.getTime() - IST_OFFSET_MIN * 60_000);
}
