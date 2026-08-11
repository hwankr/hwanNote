export interface CalendarSaveGuardOptions {
  save: () => Promise<"saved" | "blocked">;
  onBlocked: () => void | Promise<void>;
  onError: (error: unknown) => void | Promise<void>;
}

export async function ensureCalendarSaved({
  save,
  onBlocked,
  onError,
}: CalendarSaveGuardOptions): Promise<boolean> {
  try {
    const result = await save();
    if (result === "blocked") {
      await onBlocked();
      return false;
    }
    return true;
  } catch (error) {
    await onError(error);
    return false;
  }
}
