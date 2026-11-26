import { useEffect, useRef, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { acpRpcContract, type desktopInstallation, type desktopStatus } from "./acp-contract.js";
import type { z } from "zod";

const copy = {
  ru: {
    title: "Приложение ZCode", install: "Установить ZCode", retry: "Повторить установку ZCode",
    current: "Установленная версия", latest: "Последняя версия", unknown: "Не определена",
    update: "Обновить ZCode", check: "Проверить обновления", checking: "Проверка…", available: "Найдено обновление ZCode",
    releaseError: "Не удалось проверить последнюю версию ZCode.", manual: "Обновите эту установку вручную.", downloads: "Официальные загрузки",
    note: "Официальный пакет будет скачан и установлен на выбранном компьютере BB. Существующая установка используется без переустановки.",
    phases: { idle: "", resolving: "Поиск официального пакета…", downloading: "Скачивание ZCode…", verifying: "Проверка SHA-512…", installing: "Установка ZCode…", installed: "ZCode установлен", failed: "Не удалось установить ZCode" },
    errors: {
      custom_path_update: "Эта установка ZCode обновляется вручную.",
      installation_version_mismatch: "Версия установленного ZCode не совпала с версией официального пакета.",
      release_unavailable: "Не найден официальный пакет для этой платформы.", invalid_manifest: "Не удалось проверить данные официального пакета.", download_failed: "Не удалось скачать пакет. Проверьте доступ к zcode.z.ai и cdn-zcode.z.ai на выбранной машине.",
      invalid_download: "Размер скачанного файла не совпадает с официальным.", checksum_mismatch: "Контрольная сумма не совпала. Пакет не запускался.", unsupported_platform: "Для этой платформы автоматическая установка пока недоступна.",
      installation_failed: "Установщик завершился с ошибкой. Проверьте свободное место и права пользователя. Если ZCode уже установлен, укажите его путь в настройках.", installation_not_found: "Установщик завершился, но CLI не найден. Укажите путь к resources/glm/zcode.cjs.",
      custom_path_missing: "Указанный путь к ZCode не существует на этой машине. Исправьте его или очистите поле перед установкой.", interrupted: "Установка прервана. Можно повторить.", connection: "Не удалось получить состояние установки. Проверьте подключение выбранной машины и повторите.",
    },
  },
  en: {
    title: "ZCode application", install: "Install ZCode", retry: "Retry ZCode installation",
    current: "Installed version", latest: "Latest version", unknown: "Unknown",
    update: "Update ZCode", check: "Check for updates", checking: "Checking…", available: "ZCode update available",
    releaseError: "Could not check the latest ZCode version.", manual: "Update this installation manually.", downloads: "Official downloads",
    note: "Downloads and installs the official package on the selected BB computer. An existing installation is reused.",
    phases: { idle: "", resolving: "Finding the official package…", downloading: "Downloading ZCode…", verifying: "Verifying SHA-512…", installing: "Installing ZCode…", installed: "ZCode installed", failed: "Could not install ZCode" },
    errors: {
      custom_path_update: "This ZCode installation is updated manually.",
      installation_version_mismatch: "The installed ZCode version does not match the official package.",
      release_unavailable: "No official package found for this platform.", invalid_manifest: "Could not verify official package metadata.", download_failed: "Download failed. Check access to zcode.z.ai and cdn-zcode.z.ai on the selected computer.",
      invalid_download: "The downloaded size does not match the official package.", checksum_mismatch: "Checksum mismatch. The package was not executed.", unsupported_platform: "Automatic installation is unavailable for this platform.",
      installation_failed: "The installer failed. Check free disk space and user permissions. If ZCode is already installed, configure its CLI path.", installation_not_found: "The installer finished but the CLI was not found. Configure the resources/glm/zcode.cjs path.",
      custom_path_missing: "The custom ZCode path does not exist on this computer. Correct or clear it before installing.", interrupted: "Installation interrupted. You can retry.", connection: "Could not get installation status. Check the selected computer's connection and retry.",
    },
  },
};
type Status = z.infer<typeof desktopStatus>;
type Installation = z.infer<typeof desktopInstallation>;
const active = (value: Installation | null) => value && ["resolving", "downloading", "verifying", "installing"].includes(value.phase);

export function DesktopInstall({ hostId, language, onInstalled }: { hostId: string; language: "ru" | "en"; onInstalled: () => void }) {
  const rpc = useRpc<typeof acpRpcContract>();
  const text = copy[language];
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState(false);
  const [starting, setStarting] = useState(false);
  const [checking, setChecking] = useState(false);
  const generation = useRef(0);
  const refreshStatus = useRef<(refresh?: boolean) => Promise<void>>(async () => {});
  const completed = useRef(onInstalled);
  completed.current = onInstalled;
  useEffect(() => {
    const request = ++generation.current;
    let timer: ReturnType<typeof setTimeout>;
    let sequence = 0;
    let previous: Status | null = null;
    setStatus(null); setStarting(false); setChecking(false); setError(false);
    async function poll(refresh = false) {
      clearTimeout(timer);
      const call = ++sequence;
      const isLatest = () => request === generation.current && call === sequence;
      try {
        const value = await rpc.call("zcode.installStatus", { hostId, ...(refresh && { refresh }) });
        if (!isLatest()) return;
        setStatus(value); setError(false);
        if (previous && value.currentEntry &&
            (previous.currentEntry !== value.currentEntry || previous.currentVersion !== value.currentVersion ||
              (active(previous) && value.phase === "installed"))) completed.current();
        previous = value;
      } catch { if (isLatest()) setError(true); }
      finally {
        if (isLatest()) {
          setChecking(false);
          timer = setTimeout(() => void poll(), active(previous) ? 2000 : 30_000);
        }
      }
    }
    refreshStatus.current = poll;
    if (hostId) void poll();
    return () => { generation.current++; clearTimeout(timer); };
  }, [hostId, rpc]);

  async function install(upgrade: boolean) {
    const request = generation.current;
    setStarting(true); setError(false);
    try {
      const value = await rpc.call("zcode.install", { hostId, ...(upgrade && { upgrade }) });
      if (request !== generation.current) return;
      setStatus(current => current && { ...current, ...value });
      await refreshStatus.current();
    } catch { if (request === generation.current) setError(true); }
    finally { if (request === generation.current) setStarting(false); }
  }
  const busy = starting || Boolean(active(status));
  return <section className="flex min-w-0 flex-col gap-2 rounded-md border p-3" aria-label={text.title} aria-busy={busy || checking}>
    <strong>{text.title}</strong>
    <p className="text-muted-foreground">{text.note}</p>
    {status && <p>{text.current} · {status.currentVersion ?? text.unknown} <span className="text-muted-foreground"> / {text.latest} · {status.latestVersion ?? text.unknown}</span></p>}
    {status?.updateAvailable && !busy && <p role="status">{text.available} · {status.latestVersion}{!status.canUpdate && <>. {text.manual} <a className="underline" href="https://zcode.z.ai/en/docs/install" target="_blank" rel="noreferrer">{text.downloads}</a></>}</p>}
    <div className="flex flex-wrap gap-2">
      {status && !status.currentEntry && <button className="rounded-md border px-3 py-1.5 disabled:opacity-50" disabled={!hostId || busy || checking} onClick={() => void install(false)}>{status.phase === "failed" ? text.retry : text.install}</button>}
      {status?.updateAvailable && status.canUpdate && <button className="rounded-md border px-3 py-1.5 font-medium disabled:opacity-50" disabled={busy || checking} onClick={() => void install(true)}>{text.update}</button>}
      <button className="rounded-md border px-3 py-1.5 disabled:opacity-50" disabled={!hostId || busy || checking} onClick={() => { setChecking(true); void refreshStatus.current(true); }}>{checking ? text.checking : text.check}</button>
    </div>
    {status && status.phase !== "idle" && <p role="status">{text.phases[status.phase]}{status.version ? ` · ${status.version}` : ""}{status.total > 0 && active(status) ? ` · ${Math.floor(status.downloaded / 1048576)} / ${Math.ceil(status.total / 1048576)} MB` : ""}</p>}
    {status?.currentEntry && <code className="break-all text-xs text-muted-foreground">{status.currentEntry}</code>}
    {status?.releaseError && <p className="text-muted-foreground">{text.releaseError}</p>}
    {(error || status?.error) && <p role="alert" className="text-destructive">{text.errors[(error ? "connection" : status?.error) as keyof typeof text.errors] ?? text.errors.installation_failed}</p>}
  </section>;
}
