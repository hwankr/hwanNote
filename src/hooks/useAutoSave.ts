import { useEffect, useRef } from "react";

interface UseAutoSaveOptions {
  value: string;
  onSave: () => void | Promise<void>;
  delay?: number;
  enabled?: boolean;
}

export function useAutoSave({ value, onSave, delay = 1000, enabled = true }: UseAutoSaveOptions) {
  const onSaveRef = useRef(onSave);

  useEffect(() => {
    onSaveRef.current = onSave;
  }, [onSave]);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      void onSaveRef.current();
    }, delay);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [value, delay, enabled]);
}
