// Pure symbol/date helpers shared by every adapter (no I/O, safe in the browser).

/** Epoch seconds → YYYY-MM-DD (UTC). */
export const iso = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);

/** OCC contract symbol, e.g. NVDA261218C00185000. */
export const occ = (sym: string, expiry: string, right: 'C' | 'P', strike: number) =>
  `${sym.toUpperCase()}${expiry.slice(2).replace(/-/g, '')}${right}${String(Math.round(strike * 1000)).padStart(8, '0')}`;

/** US equity session at an instant, from New York wall-clock time (holidays not modelled). */
export function sessionAt(ms: number): 'regular' | 'pre' | 'post' | 'closed' {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  }).formatToParts(new Date(ms));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  if (['Sat', 'Sun'].includes(get('weekday'))) return 'closed';
  const mins = (Number(get('hour')) % 24) * 60 + Number(get('minute'));
  if (mins >= 570 && mins < 960) return 'regular';
  if (mins >= 240 && mins < 570) return 'pre';
  if (mins >= 960 && mins < 1200) return 'post';
  return 'closed';
}

/** Parse an OCC symbol back into its parts; null when it is not one. */
export function parseOcc(s: string): { root: string; expiry: string; right: 'C' | 'P'; strike: number } | null {
  const m = /^([A-Z.]{1,6})\s*(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/.exec(s.trim().toUpperCase());
  if (!m) return null;
  return {
    root: m[1]!,
    expiry: `20${m[2]}-${m[3]}-${m[4]}`,
    right: m[5] as 'C' | 'P',
    strike: Number(m[6]) / 1000,
  };
}
