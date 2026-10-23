import { create } from "zustand";
import { hwanNote } from "../lib/tauriApi";

type UpdateEvent = Parameters<Parameters<typeof hwanNote.updater.onStatus>[0]>[0];
type UpdateAction = "check" | "download" | "install";

export const initialUpdateState = {
  status: null as UpdateEvent["status"] | "installing" | null,
  retryAction: "check" as UpdateAction,
  version: "",
  progress: 0,
  busy: false,
  dismissed: false,
  manualCheck: false,
};

interface UpdateStore {
  status: typeof initialUpdateState.status;
  retryAction: UpdateAction;
  version: string;
  progress: number;
  busy: boolean;
  dismissed: boolean;
  manualCheck: boolean;
  receiveStatus: (event: UpdateEvent) => void;
  dismiss: () => void;
  check: () => Promise<void>;
  download: () => Promise<void>;
  install: (onInstall: () => Promise<void>) => Promise<void>;
}

let actionInFlight = false;

async function runUpdateAction(action: UpdateAction, operation: () => Promise<unknown>) {
  if (actionInFlight || useUpdateStore.getState().busy) return;
  actionInFlight = true;
  useUpdateStore.setState({
    busy: true,
    dismissed: false,
    retryAction: action,
    status: action === "check" ? "checking" : action === "download" ? "downloading" : "installing",
    ...(action === "check" ? { manualCheck: true } : {}),
    ...(action === "download" ? { progress: 0 } : {}),
  });
  try {
    await operation();
  } catch (error) {
    console.error(`Update ${action} failed:`, error);
    useUpdateStore.setState({ status: "error", dismissed: false });
  } finally {
    actionInFlight = false;
    // The app's save-before-install flow can be cancelled or blocked. Keep the
    // downloaded update available if it returns without an updater error event.
    useUpdateStore.setState((state) => ({
      busy: false,
      ...(state.status === "installing" ? { status: "downloaded" as const } : {}),
    }));
  }
}

export const useUpdateStore = create<UpdateStore>((set) => ({
  ...initialUpdateState,
  receiveStatus: (event) => set((state) => ({
    status: event.status,
    version: event.version ?? state.version,
    progress: event.progress ?? state.progress,
    busy: actionInFlight || event.status === "checking" || event.status === "downloading",
    retryAction: event.status === "checking" ? "check"
      : event.status === "downloading" ? "download" : state.retryAction,
    dismissed: ["available", "downloaded", "error"].includes(event.status) ? false : state.dismissed,
  })),
  dismiss: () => set({ dismissed: true }),
  check: () => runUpdateAction("check", () => hwanNote.updater.check()),
  download: () => runUpdateAction("download", () => hwanNote.updater.download()),
  install: (onInstall) => runUpdateAction("install", onInstall),
}));
