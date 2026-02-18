export function buildAllowedAudiobookUserIds(
  authEnabled: boolean,
  userId: string | null,
  unclaimedUserId: string,
): { preferredUserId: string; allowedUserIds: string[] } {
  if (!authEnabled) {
    return { preferredUserId: unclaimedUserId, allowedUserIds: [unclaimedUserId] };
  }

  const preferredUserId = userId ?? unclaimedUserId;
  const allowedUserIds = Array.from(new Set([preferredUserId, unclaimedUserId]));
  return { preferredUserId, allowedUserIds };
}

export function pickAudiobookOwner(
  existingUserIds: string[],
  preferredUserId: string,
  unclaimedUserId: string,
): string | null {
  const existing = new Set(existingUserIds);
  // Keep resumed writes on unclaimed scope when the book already exists there.
  if (existing.has(unclaimedUserId)) return unclaimedUserId;
  if (existing.has(preferredUserId)) return preferredUserId;
  return existingUserIds[0] ?? null;
}
