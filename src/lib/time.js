// Accounting dates follow Thai time (UTC+7, no DST). Stored timestamps stay ISO UTC.
const BKK_OFFSET_MS = 7 * 60 * 60 * 1000;

export const nowIso = (date = new Date()) => date.toISOString();

export function bangkokDate(date = new Date()) {
  const ymd = new Date(date.getTime() + BKK_OFFSET_MS).toISOString().slice(0, 10); // YYYY-MM-DD
  return { ymd, compact: ymd.replace(/-/g, '') };
}

// UTC ISO range [start, end) covering one Thai calendar day / month — for created_at filters.
export function bangkokDayRange(ymd) {
  const start = new Date(Date.parse(`${ymd}T00:00:00Z`) - BKK_OFFSET_MS);
  return [start.toISOString(), new Date(start.getTime() + 86400000).toISOString()];
}
export function isYmd(value) { return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value + 'T00:00:00Z')) && new Date(value + 'T00:00:00Z').toISOString().startsWith(value); }
