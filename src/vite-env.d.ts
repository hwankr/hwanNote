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
      };
    };
  }
}
