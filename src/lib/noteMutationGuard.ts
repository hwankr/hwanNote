export interface NoteRecoveryMutationState {
  recoveryPending: boolean;
  recoveryInFlight: boolean;
  writesSuspended: boolean;
  loadedFrom: string;
  currentSource: string;
}

export function canRunNoteLibraryMutation({
  recoveryPending,
  recoveryInFlight,
  writesSuspended,
  loadedFrom,
  currentSource,
}: NoteRecoveryMutationState): boolean {
  return (
    !recoveryPending &&
    !recoveryInFlight &&
    !writesSuspended &&
    loadedFrom === currentSource
  );
}
