import { useEffect, useCallback } from "react";
import { hwanNote } from "../lib/tauriApi";
import { translate, type AppLanguage, type TranslationKey } from "../i18n/messages";
import { useUpdateStore } from "../stores/updateStore";

interface Props {
  language: AppLanguage;
  onInstall: () => Promise<void>;
}

export default function UpdateToast({ language, onInstall }: Props) {
  const { status, version, progress, dismissed, manualCheck, busy, retryAction,
    receiveStatus, dismiss, check, download, install } = useUpdateStore();

  const t = useCallback(
    (key: TranslationKey, vars?: Record<string, string | number>) => translate(language, key, vars),
    [language]
  );

  useEffect(() => {
    return hwanNote.updater.onStatus(receiveStatus);
  }, [receiveStatus]);

  const visible = !dismissed && status !== null &&
    (manualCheck || (status !== "checking" && status !== "not-available"));
  const retry = () => retryAction === "install" ? install(onInstall)
    : retryAction === "download" ? download() : check();

  if (!visible) return null;

  return (
    <div className={`update-toast ${status === "error" ? "update-toast-error" : ""}`}
      role={status === "error" ? "alert" : "status"} aria-live="polite">
      {status === "checking" && <span className="update-toast-text">{t("update.checking")}</span>}
      {status === "not-available" && (
        <>
          <span className="update-toast-text">{t("update.upToDate")}</span>
          <button type="button" className="update-toast-btn" onClick={dismiss}>{t("update.dismiss")}</button>
        </>
      )}
      {status === "available" && (
        <>
          <span className="update-toast-text">{t("update.available", { version })}</span>
          <div className="update-toast-actions">
            <button type="button" disabled={busy} className="update-toast-btn update-toast-btn-primary" onClick={() => void download()}>
              {t("update.download")}
            </button>
            <button type="button" className="update-toast-btn" onClick={dismiss}>
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
            <button type="button" disabled={busy} className="update-toast-btn update-toast-btn-primary" onClick={() => void install(onInstall)}>
              {t("update.install")}
            </button>
            <button type="button" className="update-toast-btn" onClick={dismiss}>
              {t("update.dismiss")}
            </button>
          </div>
        </>
      )}

      {status === "installing" && <span className="update-toast-text">{t("update.installing")}</span>}
      {status === "error" && (
        <>
          <span className="update-toast-text">{t(retryAction === "download" ? "update.downloadFailed"
            : retryAction === "install" ? "update.installFailed" : "update.error")}</span>
          <div className="update-toast-actions">
            <button type="button" disabled={busy} className="update-toast-btn update-toast-btn-primary"
              onClick={() => void retry()}>{t("update.retry")}</button>
            <button type="button" className="update-toast-btn" onClick={dismiss}>{t("update.dismiss")}</button>
          </div>
        </>
      )}
    </div>
  );
}
