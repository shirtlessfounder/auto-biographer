const WINDOW_DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
const POSTING_TIME_ZONE = 'America/New_York';

export type WindowDayName = (typeof WINDOW_DAY_NAMES)[number];

export type WindowDefinition = {
  name: string;
  days: WindowDayName[];
  startMinutes: number;
  endMinutes: number;
};

export type DueWindowSlot = {
  slotId: string;
  windowName: string;
  scheduledFor: Date;
};

export type RandomFractionForSlot = (slotId: string, window: WindowDefinition) => number;

type RawWindowDefinition = {
  name?: unknown;
  days?: unknown;
  start?: unknown;
  end?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeWindowDayName(value: unknown): WindowDayName {
  if (typeof value !== 'string') {
    throw new Error('Window day names must be strings');
  }

  const normalized = value.trim().toLowerCase();

  if (WINDOW_DAY_NAMES.includes(normalized as WindowDayName)) {
    return normalized as WindowDayName;
  }

  throw new Error(`Unsupported window day name: ${String(value)}`);
}

function parseWindowDays(value: unknown): WindowDayName[] {
  if (value === undefined) {
    return [...WINDOW_DAY_NAMES];
  }

  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('Window days must be a non-empty array when provided');
  }

  return Array.from(new Set(value.map(normalizeWindowDayName)));
}

function parseClockTime(value: unknown, label: string): number {
  if (typeof value !== 'string') {
    throw new Error(`${label} must use HH:MM format`);
  }

  const match = value.trim().match(/^(?<hours>\d{2}):(?<minutes>\d{2})$/);

  if (!match?.groups) {
    throw new Error(`${label} must use HH:MM format`);
  }

  const hours = Number(match.groups.hours);
  const minutes = Number(match.groups.minutes);

  if (
    !Number.isInteger(hours)
    || !Number.isInteger(minutes)
    || hours < 0
    || hours > 23
    || minutes < 0
    || minutes > 59
  ) {
    throw new Error(`${label} must use a valid 24-hour clock time`);
  }

  return hours * 60 + minutes;
}

function stableHash(value: string): number {
  let hash = 0;

  for (const character of value) {
    hash = (hash * 31 + character.charCodeAt(0)) % 1000000;
  }

  return hash;
}

function defaultRandomFractionForSlot(slotId: string): number {
  return stableHash(slotId) / 1000000;
}

type PostingDateParts = {
  year: number;
  month: number;
  day: number;
  weekday: WindowDayName;
};

const POSTING_DATE_PARTS_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: POSTING_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  weekday: 'short',
});

const POSTING_OFFSET_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: POSTING_TIME_ZONE,
  timeZoneName: 'shortOffset',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

function getPostingDateParts(value: Date): PostingDateParts {
  let year: string | null = null;
  let month: string | null = null;
  let day: string | null = null;
  let weekday: string | null = null;

  for (const part of POSTING_DATE_PARTS_FORMATTER.formatToParts(value)) {
    if (part.type === 'year') {
      year = part.value;
    }

    if (part.type === 'month') {
      month = part.value;
    }

    if (part.type === 'day') {
      day = part.value;
    }

    if (part.type === 'weekday') {
      weekday = part.value;
    }
  }

  if (!year || !month || !day || !weekday) {
    throw new Error(`Failed to format posting date parts in ${POSTING_TIME_ZONE}`);
  }

  return {
    year: Number(year),
    month: Number(month),
    day: Number(day),
    weekday: normalizeWindowDayName(weekday),
  };
}

function formatPostingDateLabel(parts: Pick<PostingDateParts, 'year' | 'month' | 'day'>): string {
  return `${String(parts.year)}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

function getPostingOffsetMinutes(value: Date): number {
  const offsetPart = POSTING_OFFSET_FORMATTER
    .formatToParts(value)
    .find((part) => part.type === 'timeZoneName')
    ?.value;

  if (!offsetPart) {
    throw new Error(`Failed to read posting timezone offset for ${POSTING_TIME_ZONE}`);
  }

  if (offsetPart === 'GMT') {
    return 0;
  }

  const match = offsetPart.match(/^GMT(?<sign>[+-])(?<hours>\d{1,2})(?::(?<minutes>\d{2}))?$/);

  if (!match?.groups) {
    throw new Error(`Unsupported posting timezone offset format: ${offsetPart}`);
  }

  const sign = match.groups.sign === '-' ? -1 : 1;
  const hours = Number(match.groups.hours);
  const minutes = Number(match.groups.minutes ?? '0');

  return sign * (hours * 60 + minutes);
}

function resolvePostingDateTime(input: {
  year: number;
  month: number;
  day: number;
  hours: number;
  minutes: number;
}): Date {
  const utcTime = Date.UTC(input.year, input.month - 1, input.day, input.hours, input.minutes);
  const firstGuess = new Date(utcTime - getPostingOffsetMinutes(new Date(utcTime)) * 60 * 1000);
  const refinedOffsetMinutes = getPostingOffsetMinutes(firstGuess);

  return new Date(utcTime - refinedOffsetMinutes * 60 * 1000);
}

export function parseWindowsJson(input: unknown[]): WindowDefinition[] {
  return input.map((rawWindow, index) => {
    if (!isRecord(rawWindow)) {
      throw new Error(`WINDOWS_JSON entry ${String(index)} must be an object`);
    }

    const window = rawWindow as RawWindowDefinition;

    if (typeof window.name !== 'string' || window.name.trim().length === 0) {
      throw new Error(`WINDOWS_JSON entry ${String(index)} is missing a window name`);
    }

    const startMinutes = parseClockTime(window.start, `Window ${window.name} start`);
    const endMinutes = parseClockTime(window.end, `Window ${window.name} end`);

    if (endMinutes < startMinutes) {
      throw new Error(`Window ${window.name} must not end before it starts`);
    }

    return {
      name: window.name.trim(),
      days: parseWindowDays(window.days),
      startMinutes,
      endMinutes,
    };
  });
}

export function buildWindowSlotId(window: Pick<WindowDefinition, 'name'>, day: Date): string {
  return `${window.name}:${formatPostingDateLabel(getPostingDateParts(day))}`;
}

export function scheduleWindowSlot(
  window: WindowDefinition,
  day: Date,
  randomFractionForSlot: RandomFractionForSlot = defaultRandomFractionForSlot,
): DueWindowSlot {
  const postingDate = getPostingDateParts(day);
  const slotId = buildWindowSlotId(window, day);
  const spanMinutes = window.endMinutes - window.startMinutes;
  const jitterOffsetMinutes = Math.round(spanMinutes * randomFractionForSlot(slotId, window));
  const scheduledMinutes = window.startMinutes + jitterOffsetMinutes;
  const scheduledFor = resolvePostingDateTime({
    year: postingDate.year,
    month: postingDate.month,
    day: postingDate.day,
    hours: Math.floor(scheduledMinutes / 60),
    minutes: scheduledMinutes % 60,
  });

  return {
    slotId,
    windowName: window.name,
    scheduledFor,
  };
}

export function findDueWindowSlots(input: {
  windows: readonly WindowDefinition[];
  now: Date;
  claimedSlotIds: ReadonlySet<string>;
  randomFractionForSlot?: RandomFractionForSlot | undefined;
}): DueWindowSlot[] {
  const dayName = getPostingDateParts(input.now).weekday;

  return input.windows
    .filter((window) => window.days.includes(dayName))
    .map((window) => scheduleWindowSlot(window, input.now, input.randomFractionForSlot))
    .filter((slot) => !input.claimedSlotIds.has(slot.slotId))
    .filter((slot) => slot.scheduledFor.getTime() <= input.now.getTime())
    .sort((left, right) => left.scheduledFor.getTime() - right.scheduledFor.getTime());
}

type WindowTargetState = { fraction: number; offsetMinutes: number; createdAt: string };

type RuntimeStateLike = {
  insertStateIfAbsent(
    stateKey: string,
    stateJson: unknown,
  ): Promise<unknown | null>;
  getState(stateKey: string): Promise<{ stateJson: unknown } | null>;
};

export function buildWindowTargetStateKey(slotId: string): string {
  return `window_target:${slotId}`;
}

/**
 * Returns a per-day random fraction in [0, 1) for the given slot. Stored in
 * sp_runtime_state under `window_target:<slotId>` so the same offset is reused
 * across ticks within a day. Uses crypto.randomInt for real entropy (the hash
 * fallback was near-constant across consecutive days).
 */
export async function getOrCreateWindowTargetFraction(
  runtimeStateRepository: RuntimeStateLike,
  input: { slotId: string; window: WindowDefinition },
): Promise<number> {
  const stateKey = buildWindowTargetStateKey(input.slotId);
  const existing = await runtimeStateRepository.getState(stateKey);

  if (existing && typeof existing.stateJson === 'object' && existing.stateJson !== null) {
    const state = existing.stateJson as Partial<WindowTargetState>;
    if (typeof state.fraction === 'number' && state.fraction >= 0 && state.fraction < 1) {
      return state.fraction;
    }
  }

  const { randomInt } = await import('node:crypto');
  const spanMinutes = Math.max(1, input.window.endMinutes - input.window.startMinutes);
  const offsetMinutes = randomInt(0, spanMinutes);
  const fraction = offsetMinutes / spanMinutes;
  const newState: WindowTargetState = {
    fraction,
    offsetMinutes,
    createdAt: new Date().toISOString(),
  };

  const inserted = await runtimeStateRepository.insertStateIfAbsent(stateKey, newState);

  if (inserted === null) {
    // Lost race with another ticker — read the winning value.
    const winner = await runtimeStateRepository.getState(stateKey);
    if (winner && typeof winner.stateJson === 'object' && winner.stateJson !== null) {
      const state = winner.stateJson as Partial<WindowTargetState>;
      if (typeof state.fraction === 'number' && state.fraction >= 0 && state.fraction < 1) {
        return state.fraction;
      }
    }
  }

  return fraction;
}
