/// <reference types="vite/client" />

export {};

declare global {
  interface Window {
    hwanShell?: {
      openExternal: (url: string) => Promise<void>;
    };
    hwanNote?: {
      window: {
        minimize: () => Promise<void>;
        toggleMaximize: () => Promise<boolean>;
        close: () => Promise<void>;
      };
      note: {
        save: (filePath: string, content: string) => Promise<boolean>;
        read: (filePath: string) => Promise<string>;
        list: (dirPath: string) => Promise<string[]>;
        autoSave: (
          noteId: string,
          title: string,
          content: string,
          folderPath: string,
          isTitleManual: boolean
        ) => Promise<{ filePath: string }>;
        loadAll: () => Promise<
          Array<{
            noteId: string;
            title: string;
            isTitleManual: boolean;
            plainText: string;
            content: string;
            folderPath: string;
            createdAt: number;
            updatedAt: number;
            filePath: string;
          }>
        >;
        importTxt: () => Promise<Array<{ title: string; content: string; filePath: string }> | null>;
        saveTxt: (filePath: string, content: string) => Promise<boolean>;
        delete: (noteId: string) => Promise<boolean>;
      };
      updater: {
        download: () => Promise<void>;
        install: () => Promise<void>;
        onStatus: (callback: (data: {
          status: "checking" | "available" | "not-available" | "downloading" | "downloaded" | "error";
          version?: string;
          progress?: number;
          error?: string;
        }) => void) => () => void;
      };
      settings: {
        browseAutoSaveDir: () => Promise<string | null>;
        setAutoSaveDir: (dir: string | null) => Promise<{
          customDir: string | null;
          effectiveDir: string;
          isDefault: boolean;
        }>;
        getAutoSaveDir: () => Promise<{
          customDir: string | null;
          effectiveDir: string;
          isDefault: boolean;
        }>;
      };
    };
  }
}
