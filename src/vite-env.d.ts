/// <reference types="vite/client" />

export {};

declare global {
  interface Window {
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
        getAutoSaveDir: () => Promise<string>;
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
      };
    };
  }
}
