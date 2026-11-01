import type { AutoSaveDirInfo } from "./tauriApi";

/** True when two auto-save directory reports would show the same state. */
export function isSameAutoSaveDirInfo(
  left: AutoSaveDirInfo | null,
  right: AutoSaveDirInfo | null
): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right) {
    return false;
  }

  return (
    left.customDir === right.customDir &&
    left.effectiveDir === right.effectiveDir &&
    left.isDefault === right.isDefault &&
    left.status === right.status &&
    left.expectedDir === right.expectedDir &&
    left.error === right.error
  );
}
