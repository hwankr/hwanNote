import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import {
  isSupportedLanguage,
  localeTagFromLanguage,
  translate,
  type AppLanguage,
  type TranslationKey
} from "./messages";

const LANGUAGE_KEY = "hwan-note:language";

interface I18nContextValue {
  language: AppLanguage;
  setLanguage: (language: AppLanguage) => void;
  localeTag: string;
  t: (key: TranslationKey, vars?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

function readInitialLanguage(): AppLanguage {
  try {
    const raw = window.localStorage.getItem(LANGUAGE_KEY);
    if (raw && isSupportedLanguage(raw)) {
      return raw;
    }
  } catch (error) {
    console.warn("Failed to read language from localStorage", error);
  }

  return "ko";
}

interface I18nProviderProps {
  children: ReactNode;
}

export function I18nProvider({ children }: I18nProviderProps) {
  const [language, setLanguageState] = useState<AppLanguage>(readInitialLanguage);

  const setLanguage = useCallback((nextLanguage: AppLanguage) => {
    setLanguageState(nextLanguage);

    try {
      window.localStorage.setItem(LANGUAGE_KEY, nextLanguage);
    } catch (error) {
      console.warn("Failed to save language", error);
    }
  }, []);

  const value = useMemo<I18nContextValue>(() => {
    const localeTag = localeTagFromLanguage(language);

    return {
      language,
      setLanguage,
      localeTag,
      t: (key, vars) => translate(language, key, vars)
    };
  }, [language, setLanguage]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const context = useContext(I18nContext);
  if (!context) {
    throw new Error("useI18n must be used within I18nProvider");
  }

  return context;
}
