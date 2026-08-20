import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: vi.fn() }));

import { hwanNote } from "./tauriApi";

describe("note library mutation IPC", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("passes loadedFrom when deleting a note", () => {
    hwanNote.note.delete("shared-note", "cloud");

    expect(invokeMock).toHaveBeenCalledWith("cmd_note_delete", {
      noteId: "shared-note",
      loadedFrom: "cloud",
    });
  });

  it("passes loadedFrom to folder mutations", () => {
    hwanNote.folder.create("alpha", "local_fallback");
    hwanNote.folder.rename("alpha", "beta", "local_fallback");
    hwanNote.folder.delete("beta", "local_fallback");

    expect(invokeMock).toHaveBeenNthCalledWith(1, "cmd_folder_create", {
      folderPath: "alpha",
      loadedFrom: "local_fallback",
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "cmd_folder_rename", {
      from: "alpha",
      to: "beta",
      loadedFrom: "local_fallback",
    });
    expect(invokeMock).toHaveBeenNthCalledWith(3, "cmd_folder_delete", {
      folderPath: "beta",
      loadedFrom: "local_fallback",
    });
  });

  it("keeps custom directory reads and explicit changes on dedicated settings commands", () => {
    hwanNote.settings.getAutoSaveDir();
    hwanNote.settings.setAutoSaveDir("D:/Notes");
    hwanNote.settings.setAutoSaveDir(null);

    expect(invokeMock).toHaveBeenNthCalledWith(1, "cmd_settings_get_autosave_dir");
    expect(invokeMock).toHaveBeenNthCalledWith(2, "cmd_settings_set_autosave_dir", {
      dir: "D:/Notes",
    });
    expect(invokeMock).toHaveBeenNthCalledWith(3, "cmd_settings_set_autosave_dir", {
      dir: null,
    });
  });
});
