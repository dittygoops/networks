// The ONE timestamp format this codebase stores. Everything already in the
// schema is datetime('now'), which is 'YYYY-MM-DD HH:MM:SS' UTC: a space
// separator, no T, no Z, no fractional seconds, no offset.
//
// Getting this wrong does not throw and does not fail a test that uses
// julianday(). Measured on this machine 2026-08-05:
//
//   strftime('%Y-%m-%dT%H:%M:%SZ','now','-1 hour') <= datetime('now')  ->  0
//   strftime('%Y-%m-%dT%H:%M:%SZ','now','-1 day')  <= datetime('now')  ->  1
//   strftime('%Y-%m-%d %H:%M:%S','now','-1 hour')  <= datetime('now')  ->  1
//   SELECT julianday('2026-08-04T10:00:00Z')                           ->  2461256.91666667
//   SELECT julianday('2026-08-04 10:00:00')                            ->  2461256.91666667
//
// SQLite compares TEXT bytewise. 'T' is 0x54, ' ' is 0x20, so an ISO-Z string
// sorts ABOVE datetime('now') for the rest of the SAME UTC DAY and below it
// once the date rolls over. A past due time therefore reads not-yet-due until
// midnight UTC: the poller does not stop, its cadence collapses to roughly one
// poll a day in every tier, silently. julianday parses both, which is why the
// round-trip test in test/reply-time.test.ts runs the real selection query
// instead, against a due time pinned to the current UTC date.
export const SQL_TIME_SHAPE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

export function toSqlTime(d: Date): string {
  // toISOString is always UTC and always 'YYYY-MM-DDTHH:mm:ss.sssZ'. Slicing at
  // 19 drops '.sssZ'; replacing 'T' gives the datetime('now') form exactly.
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

// Gmail hands internalDate back as a STRING of epoch milliseconds, not a
// number. It is Gmail's own receive time; the Date: header is written by the
// sender's mail client and is routinely wrong by hours or years, and
// time-to-reply is one of the metrics this feature exists to produce.
export function fromInternalDate(internalDateMs: string): string {
  return toSqlTime(new Date(Number(internalDateMs)));
}

// Cadence arithmetic lives here rather than in SQL's datetime('now', '+4
// hours') because the cycle injects `now` so the age tiers and the 60 day close
// are testable without waiting. Both mistakes have already been made and fixed
// once in listen.ts.
export function addHours(from: Date, hours: number): string {
  return toSqlTime(new Date(from.getTime() + hours * 3600_000));
}
