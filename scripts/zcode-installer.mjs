import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { compareDesktopVersions, desktopCandidates, desktopVersion, installedDesktop } from "./zcode-installation.mjs";

const SITE = "https://zcode.z.ai/en/docs/install";
const CDN = "https://cdn-zcode.z.ai";
const LIMIT = 1024 * 1024 * 1024;
const states = new Set(["idle", "resolving", "downloading", "verifying", "installing", "installed", "failed"]);
const active = new Set(["resolving", "downloading", "verifying", "installing"]);
const targetFor = (platform, arch) => ({ win32: "windows", darwin: "macos", linux: "linux" }[platform] && ["x64", "arm64"].includes(arch) ? `${{ win32: "windows", darwin: "macos", linux: "linux" }[platform]}-${arch}` : null);
const suffixFor = platform => ({ win32: ".exe", darwin: ".zip", linux: ".AppImage" }[platform]);

function fail(code) { throw new Error(code); }
export function parseDesktopRelease(html, target) {
  const matches = [...html.matchAll(/https:\/\/cdn-zcode\.z\.ai\/zcode\/electron\/releases\/(\d+\.\d+\.\d+)\/([a-z0-9-]+)\//g)];
  const versions = matches.filter(m => m[2] === target).map(m => m[1]);
  versions.sort((a, b) => compareDesktopVersions(b, a));
  if (!versions.length) fail("release_unavailable");
  return versions[0];
}
export function parseDesktopManifest(text, version, platform, arch) {
  // Read only electron-updater's fixed header, never executable release notes.
  const head = text.split(/^releaseNotes:/m)[0];
  if (!new RegExp(`^version: ${version.replaceAll(".", "\\.")}\\r?$`, "m").test(head)) fail("invalid_manifest");
  const files = [...head.matchAll(/^  - url: ([A-Za-z0-9._-]+)\r?\n    sha512: ([A-Za-z0-9+/=]+)\r?\n    size: (\d+)\r?$/gm)];
  const middle = { win32: "win", darwin: "mac", linux: "linux" }[platform];
  const name = `ZCode-${version}-${middle}-${arch}${suffixFor(platform)}`;
  const file = files.find(m => m[1] === name);
  if (!file || !/^[A-Za-z0-9+/]{86}==$/.test(file[2]) || +file[3] < 1 || +file[3] > LIMIT) fail("invalid_manifest");
  return { name, sha512: file[2], size: +file[3] };
}

export function runDesktopInstaller(command, args, options = {}) {
  const { timeout, signal, ...spawnOptions } = options;
  const deadline = timeout ? AbortSignal.timeout(timeout) : undefined;
  const childSignal = signal && deadline ? AbortSignal.any([signal, deadline]) : signal ?? deadline;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...spawnOptions, signal: childSignal, windowsHide: true, shell: false, stdio: "ignore" });
    child.on("error", () => reject(new Error("installation_failed")));
    child.on("exit", code => code === 0 ? resolve() : reject(new Error("installation_failed")));
  });
}

export function createDesktopInstaller({ dataDir, platform = process.platform, arch = process.arch, fetchImpl = fetch, run = runDesktopInstaller, env = process.env }) {
  const root = path.join(dataDir, "zcode");
  const stateFile = path.join(root, "install.json");
  const lockFile = path.join(root, "install.lock");
  let running;
  let releaseCheck;
  const idle = { phase: "idle", downloaded: 0, total: 0, version: null, entry: null, error: null };
  function locked() {
    try {
      const age = Date.now() - fs.statSync(lockFile).mtimeMs;
      if (age < 20 * 60_000) return true;
      fs.unlinkSync(lockFile);
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    return false;
  }
  function readState() {
    try {
      const saved = JSON.parse(fs.readFileSync(stateFile, "utf8"));
      if (states.has(saved.phase)) return active.has(saved.phase) && !locked() ? { ...saved, phase: "failed", error: "interrupted" } : saved;
    } catch { /* first run */ }
    return idle;
  }
  let state = readState();
  const update = patch => {
    state = { ...state, ...patch };
    fs.mkdirSync(root, { recursive: true });
    const temp = path.join(root, `state-${randomUUID()}.tmp`);
    try { fs.writeFileSync(temp, JSON.stringify(state), { mode: 0o600 }); fs.renameSync(temp, stateFile); }
    finally { fs.rmSync(temp, { force: true }); }
  };
  const status = () => {
    if (!running) state = readState();
    if (state.phase === "installed" && (!state.entry || !fs.existsSync(state.entry))) return { ...idle };
    return { ...state };
  };
  function local(nativeEntry) {
    const override = nativeEntry?.trim() || env.ZCODE_NATIVE_ENTRY;
    const entry = override || installedDesktop(dataDir, platform, env);
    let exists = false;
    try { exists = Boolean(entry && fs.statSync(entry).isFile()); } catch { /* absent */ }
    const version = exists ? desktopVersion(entry) : null;
    return { entry: exists ? entry : null, version, override: Boolean(override),
      canUpdate: Boolean(exists && version && !override && (platform !== "win32" || entry === desktopCandidates(platform, env)[0])) };
  }

  async function response(url, signal) {
    const u = new URL(url);
    if (u.protocol !== "https:" || ![new URL(SITE).origin, CDN].includes(u.origin)) fail("download_failed");
    const result = await fetchImpl(u.href, { signal, redirect: "error" });
    if (!result.ok || !result.body) fail("download_failed");
    return result;
  }
  async function small(url, signal) {
    const r = await response(url, signal); const chunks = []; let count = 0;
    for await (const chunk of r.body) { count += chunk.length; if (count > 4 * 1024 * 1024) fail("invalid_manifest"); chunks.push(chunk); }
    return Buffer.concat(chunks).toString("utf8");
  }
  async function release(signal) {
    const target = targetFor(platform, arch);
    if (!target) fail("unsupported_platform");
    const version = parseDesktopRelease(await small(SITE, signal), target);
    const base = `${CDN}/zcode/electron/releases/${version}/${target}/`;
    const file = parseDesktopManifest(await small(base + "latest.yml", signal), version, platform, arch);
    return { version, file, url: base + file.name };
  }
  async function check(nativeEntry = "", refresh = false, checkUpdates = true) {
    const current = local(nativeEntry);
    const file = path.join(root, "release.json");
    async function read() {
      try { return JSON.parse(await fs.promises.readFile(file, "utf8")); }
      catch { return {}; }
    }
    const cached = await read();
    const target = targetFor(platform, arch);
    let metadata = cached.target === target ? cached : {};
    if (checkUpdates && target && (refresh || Date.now() - (metadata.checkedAt || 0) > (metadata.error ? 60_000 : 30 * 60_000))) {
      releaseCheck ??= (async () => {
        let result;
        try { result = { latest: (await release(AbortSignal.timeout(8_000))).version, error: null }; }
        catch { result = { latest: metadata.latest || null, error: "release_unavailable" }; }
        result = { ...result, checkedAt: Date.now(), target };
        let temp;
        try {
          await fs.promises.mkdir(root, { recursive: true });
          temp = path.join(root, `release-${randomUUID()}.tmp`);
          await fs.promises.writeFile(temp, JSON.stringify(result), { mode: 0o600, flag: "wx" });
          await fs.promises.rename(temp, file);
        } catch { /* Metadata is still usable for this check. */ }
        finally { if (temp) await fs.promises.rm(temp, { force: true }).catch(() => {}); }
        return result;
      })().finally(() => { releaseCheck = undefined; });
      metadata = await releaseCheck;
    }
    const latest = metadata.latest || null;
    const updateAvailable = Boolean(current.version && latest && compareDesktopVersions(latest, current.version) > 0);
    return { ...status(), currentVersion: current.version, currentEntry: current.entry, latestVersion: latest,
      releaseError: metadata.error || (!target ? "unsupported_platform" : null), updateAvailable,
      canUpdate: current.canUpdate && Boolean(target), customPath: current.override };
  }

  async function install(signal, nativeEntry, upgrade) {
    let work;
    try {
      const selected = nativeEntry?.trim() || env.ZCODE_NATIVE_ENTRY;
      if (selected) {
        if (upgrade) fail("custom_path_update");
        try { if (!fs.statSync(selected).isFile()) fail("custom_path_missing"); }
        catch { fail("custom_path_missing"); }
        update({ phase: "installed", entry: selected }); return;
      }
      const found = installedDesktop(dataDir, platform, env);
      if (found && !upgrade) { update({ phase: "installed", entry: found, version: desktopVersion(found) }); return; }
      const current = local(nativeEntry);
      if (upgrade && !current.canUpdate) fail("custom_path_update");
      const { version, file, url } = await release(signal);
      if (upgrade && compareDesktopVersions(version, current.version) <= 0) {
        update({ phase: "installed", entry: current.entry, version: current.version });
        return;
      }
      signal.throwIfAborted();
      update({ phase: "downloading", version, total: file.size });
      fs.mkdirSync(path.join(root, "versions"), { recursive: true, mode: 0o700 });
      work = fs.mkdtempSync(path.join(root, "versions", `${version}-`));
      const archive = path.join(work, file.name);
      const r = await response(url, signal);
      const hash = createHash("sha512"); let size = 0, lastUpdate = 0;
      const handle = await fs.promises.open(archive, "wx", 0o700);
      try {
        for await (const chunk of r.body) {
          signal.throwIfAborted(); size += chunk.length;
          if (size > file.size || size > LIMIT) fail("invalid_download");
          hash.update(chunk); await handle.writeFile(chunk);
          if (Date.now() - lastUpdate > 500) { update({ downloaded: size }); lastUpdate = Date.now(); }
        }
      } finally { await handle.close(); }
      update({ phase: "verifying", downloaded: size });
      if (size !== file.size || hash.digest("base64") !== file.sha512) fail("checksum_mismatch");
      signal.throwIfAborted(); update({ phase: "installing" });
      let entry;
      if (platform === "linux") {
        await run(archive, ["--appimage-extract"], { cwd: work, signal, timeout: 180_000, stdio: "ignore" });
        entry = path.join(work, "squashfs-root/resources/glm/zcode.cjs");
      } else if (platform === "darwin") {
        await run("/usr/bin/ditto", ["-x", "-k", archive, work], { signal, timeout: 180_000 });
        entry = path.join(work, "ZCode.app/Contents/Resources/glm/zcode.cjs");
      } else {
        // Use the vendor updater only for the default per-user installation.
        // A machine-wide or undiscovered copy must be updated by its owner.
        const registryCheck = upgrade
          ? "$p='HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'; if(Get-ItemProperty $p -ErrorAction SilentlyContinue | Where-Object {$_.DisplayName -eq 'ZCode'}) {exit 9}"
          : "$p=@('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'); if(Get-ItemProperty $p -ErrorAction SilentlyContinue | Where-Object {$_.DisplayName -eq 'ZCode'}) {exit 9}";
        await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", registryCheck], { signal, timeout: 15_000 });
        await run(archive, ["/S", "/currentuser"], { signal, timeout: 240_000 });
        entry = desktopCandidates(platform, env).find(p => fs.existsSync(p));
      }
      signal.throwIfAborted();
      if (!entry || !fs.statSync(entry).isFile()) fail("installation_not_found");
      const actualVersion = desktopVersion(entry);
      if ((upgrade || actualVersion) && actualVersion !== version) fail("installation_version_mismatch");
      if (platform !== "win32") {
        const pointer = path.join(root, `current-${randomUUID()}.tmp`);
        try { fs.writeFileSync(pointer, JSON.stringify({ directory: path.basename(work), version, platform }), { mode: 0o600 }); fs.renameSync(pointer, path.join(root, "current.json")); }
        finally { fs.rmSync(pointer, { force: true }); }
      }
      work = undefined;
      // Publication succeeded. A locked download must never roll back a valid
      // installation or delete the directory referenced by current.json.
      try { fs.rmSync(archive, { force: true }); } catch { /* retry cleanup later */ }
      update({ phase: "installed", entry });
    } catch (error) {
      const codes = ["release_unavailable", "invalid_manifest", "download_failed", "invalid_download", "checksum_mismatch", "unsupported_platform", "installation_failed", "installation_not_found", "custom_path_missing", "custom_path_update", "installation_version_mismatch"];
      update({ phase: "failed", error: signal.aborted ? "interrupted" : codes.includes(error?.message) ? error.message : "installation_failed" });
    } finally {
      // Only remove a fresh staging directory created by this operation.
      if (work && path.dirname(path.resolve(work)) === path.resolve(root, "versions")) fs.rmSync(work, { recursive: true, force: true });
    }
  }
  return {
    status,
    check,
    start({ signal, nativeEntry = "", upgrade = false }) {
      if (running || locked()) return status();
      fs.mkdirSync(root, { recursive: true });
      let lock;
      try { lock = fs.openSync(lockFile, "wx", 0o600); }
      catch (error) { if (error.code === "EEXIST") return status(); throw error; }
      function unlock() { fs.closeSync(lock); fs.rmSync(lockFile, { force: true }); }
      try {
        update({ phase: "resolving", downloaded: 0, total: 0, version: null, entry: null, error: null });
        running = Promise.resolve().then(() => install(signal, nativeEntry, upgrade)).finally(() => { unlock(); running = undefined; });
      } catch (error) { unlock(); throw error; }
      return status();
    },
    async wait() { await running; return status(); },
  };
}
