import { useEffect, useState, useCallback } from "react";
import { translate, type AppLanguage, type TranslationKey } from "../i18n/messages";

type UpdateStatus = "checking" | "available" | "not-available" | "downloading" | "downloaded" | "error";

interface Props {
  language: AppLanguage;
}

export default function UpdateToast({ language }: Props) {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [version, setVersion] = useState("");
  const [progress, setProgress] = useState(0);
  const [dismissed, setDismissed] = useState(false);

  const t = useCallback(
    (key: TranslationKey, vars?: Record<string, string | number>) => translate(language, key, vars),
    [language]
  );

  useEffect(() => {
    const unsubscribe = window.hwanNote?.updater?.onStatus((data) => {
      setStatus(data.status);
      if (data.version) setVersion(data.version);
      if (data.progress !== undefined) setProgress(data.progress);

      // Reappear on new actionable state
      if (data.status === "available" || data.status === "downloaded") {
        setDismissed(false);
      }
    });

    return () => { unsubscribe?.(); };
  }, []);

  // Auto-dismiss error after 5 seconds
  useEffect(() => {
    if (status !== "error") return;
    const timer = setTimeout(() => setDismissed(true), 5000);
    return () => clearTimeout(timer);
  }, [status]);

  const visible = !dismissed && status !== null && status !== "checking" && status !== "not-available";

  if (!visible) return null;

  return (
    <div className={`update-toast ${status === "error" ? "update-toast-error" : ""}`}>
      {status === "available" && (
        <>
          <span className="update-toast-text">{t("update.available", { version })}</span>
          <div className="update-toast-actions">
            <button className="update-toast-btn update-toast-btn-primary" onClick={() => void window.hwanNote?.updater?.download()}>
              {t("update.download")}
            </button>
            <button className="update-toast-btn" onClick={() => setDismissed(true)}>
              {t("update.dismiss")}
            </button>
          </div>
        </>
      )}

      {status === "downloading" && (
        <>
          <span className="update-toast-text">{t("update.downloading", { progress })}</span>
          <div className="update-toast-progress">
            <div className="update-toast-progress-bar" style={{ width: `${progress}%` }} />
          </div>
        </>
      )}

      {status === "downloaded" && (
        <>
          <span className="update-toast-text">{t("update.downloaded")}</span>
          <div className="update-toast-actions">
            <button className="update-toast-btn update-toast-btn-primary" onClick={() => void window.hwanNote?.updater?.install()}>
              {t("update.install")}
            </button>
            <button className="update-toast-btn" onClick={() => setDismissed(true)}>
              {t("update.dismiss")}
            </button>
          </div>
        </>
      )}

      {status === "error" && (
        <span className="update-toast-text">{t("update.error")}</span>
      )}
    </div>
  );
}
