import { normalizeVersion } from '@/lib/shared/changelog';

export type ChangelogVersionCheckResponse = {
  shouldOpen: boolean;
  currentVersion: string;
  lastSeenVersion: string | null;
};

type RefLike = { current: string | null };

export type RunChangelogCheckArgs = {
  isSessionPending: boolean;
  sessionUserId: string | null | undefined;
  appVersion: string | null | undefined;
  completedRef: RefLike;
  inFlightRef: RefLike;
  postCheck: (currentVersion: string) => Promise<ChangelogVersionCheckResponse>;
  onShouldOpen: () => void;
  retryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

export async function runChangelogCheck(args: RunChangelogCheckArgs): Promise<void> {
  const sessionUserId = args.sessionUserId ?? null;
  if (args.isSessionPending || !sessionUserId) return;

  const currentVersion = normalizeVersion(args.appVersion || '');
  if (!currentVersion) return;

  const checkKey = `${sessionUserId}:${currentVersion}`;
  if (args.completedRef.current === checkKey) return;
  if (args.inFlightRef.current === checkKey) return;
  args.inFlightRef.current = checkKey;

  const retryDelayMs = args.retryDelayMs ?? 400;
  const sleep = args.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const result = await args.postCheck(currentVersion);
        args.completedRef.current = checkKey;
        if (result.shouldOpen) {
          args.onShouldOpen();
        }
        return;
      } catch (error) {
        if (attempt === 1) throw error;
        await sleep(retryDelayMs);
      }
    }
  } catch (error) {
    console.warn('Failed to check changelog version:', error);
  } finally {
    if (args.inFlightRef.current === checkKey) {
      args.inFlightRef.current = null;
    }
  }
}

export type ScheduleChangelogCheckArgs = RunChangelogCheckArgs & {
  delayMs?: number;
};

export function scheduleChangelogCheck(args: ScheduleChangelogCheckArgs): () => void {
  let active = true;
  const timer = setTimeout(() => {
    if (!active) return;
    void runChangelogCheck(args);
  }, args.delayMs ?? 120);

  return () => {
    active = false;
    clearTimeout(timer);
  };
}
