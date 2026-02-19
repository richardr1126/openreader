export type TimestampMs = number;

export function nowTimestampMs(): TimestampMs {
  return Date.now();
}

export function nextUtcMidnightTimestampMs(fromMs: TimestampMs = nowTimestampMs()): TimestampMs {
  const now = new Date(fromMs);
  const tomorrow = new Date(now);
  tomorrow.setUTCDate(now.getUTCDate() + 1);
  tomorrow.setUTCHours(0, 0, 0, 0);
  return tomorrow.getTime();
}

export function coerceTimestampMs(value: unknown, fallback: TimestampMs = nowTimestampMs()): TimestampMs {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.floor(value);
  }

  if (value instanceof Date) {
    return value.getTime();
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      const asNumber = Number(trimmed);
      if (Number.isFinite(asNumber)) return Math.floor(asNumber);

      const asDate = Date.parse(trimmed);
      if (Number.isFinite(asDate)) return Math.floor(asDate);
    }
  }

  return fallback;
}
