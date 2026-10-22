import { AppError } from './errors.ts';

export const TIMEZONES = [
  'UTC',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'Europe/London',
  'Europe/Paris',
] as const;

export function isTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function zoneOffsetMs(date: Date, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );
  const asUTC = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return asUTC - date.getTime();
}

/** Convert a `datetime-local` value in an IANA zone to a UTC Date. */
export function zonedLocalToUtc(local: string, timeZone: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local)) {
    throw new AppError(400, 'invalid_time', 'Scheduled time must use YYYY-MM-DDTHH:mm');
  }
  if (!isTimezone(timeZone)) {
    throw new AppError(400, 'invalid_timezone', 'Unknown timezone');
  }
  const [date, time] = local.split('T');
  if (!date || !time) throw new AppError(400, 'invalid_time', 'Scheduled time is incomplete');
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  if ([y, m, d, hh, mm].some((n) => Number.isNaN(n))) {
    throw new AppError(400, 'invalid_time', 'Scheduled time is invalid');
  }
  let utc = Date.UTC(y!, m! - 1, d!, hh!, mm!, 0);
  for (let pass = 0; pass < 2; pass += 1) {
    utc = Date.UTC(y!, m! - 1, d!, hh!, mm!, 0) - zoneOffsetMs(new Date(utc), timeZone);
  }
  return new Date(utc);
}
