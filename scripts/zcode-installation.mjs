import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

export function desktopCandidates(platform = process.platform, env = process.env, home = os.homedir()) {
  if (platform === "win32") return [
    path.join(env.LOCALAPPDATA || path.join(home, "AppData/Local"), "Programs/ZCode/resources/glm/zcode.cjs"),
    ...[env.ProgramFiles, env["ProgramFiles(x86)"]].filter(Boolean).map(p => path.join(p, "ZCode/resources/glm/zcode.cjs")),
  ];
  if (platform === "darwin") return ["/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs", path.join(home, "Applications/ZCode.app/Contents/Resources/glm/zcode.cjs")];
  return ["/opt/ZCode/resources/glm/zcode.cjs", "/opt/zcode/resources/glm/zcode.cjs", "/usr/share/zcode/resources/glm/zcode.cjs", path.join(home, "Applications/ZCode/resources/glm/zcode.cjs")];
}

export function installedDesktop(dataDir, platform = process.platform, env = process.env) {
  const existing = desktopCandidates(platform, env).find(p => fs.existsSync(p));
  if (!dataDir || platform === "win32") return existing || null;
  try {
    const current = JSON.parse(fs.readFileSync(path.join(dataDir, "zcode/current.json"), "utf8"));
    if (!/^[\w.-]+$/.test(current.directory) || current.directory.startsWith(".") || current.platform !== platform) return existing || null;
    const root = path.join(dataDir, "zcode/versions", current.directory);
    const entry = platform === "darwin" ? path.join(root, "ZCode.app/Contents/Resources/glm/zcode.cjs") : path.join(root, "squashfs-root/resources/glm/zcode.cjs");
    if (!fs.statSync(entry).isFile()) return existing || null;
    const externalVersion = desktopVersion(existing);
    return externalVersion && compareDesktopVersions(externalVersion, current.version) > 0 ? existing : entry;
  } catch { return existing || null; }
}

export const desktopVersionPattern = /^\d{1,6}\.\d{1,6}\.\d{1,6}$/;

export function compareDesktopVersions(left, right) {
  const tuple = value => desktopVersionPattern.test(value) ? value.split(".").map(Number) : [0, 0, 0];
  const a = tuple(left), b = tuple(right);
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

function readAsarBytes(file, length, position) {
  const bytes = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const count = fs.readSync(file, bytes, offset, Math.min(length - offset, 1024 * 1024), position + offset);
    if (!count) throw new Error("Truncated ZCode package metadata");
    offset += count;
  }
  return bytes;
}

function packedVersion(resources) {
  try {
    const file = fs.openSync(path.join(resources, "app.asar"), "r");
    try {
      const prefix = readAsarBytes(file, 16, 0);
      const size = prefix.readUInt32LE(12), data = 8 + prefix.readUInt32LE(4);
      if (size < 2 || size > 64 * 1024 * 1024 || data < size + 16) return null;
      const header = readAsarBytes(file, size, 16);
      const manifest = JSON.parse(header.toString("utf8")).files["package.json"];
      const offset = Number(manifest.offset), length = manifest.size;
      if (manifest.unpacked || !Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(length) || length < 2 || length > 1024 * 1024) return null;
      const content = readAsarBytes(file, length, data + offset);
      const version = JSON.parse(content.toString("utf8")).version;
      return desktopVersionPattern.test(version) ? version : null;
    } finally { fs.closeSync(file); }
  } catch { return null; }
}

let lastWindowsVersion;
function windowsExecutableVersion(resources) {
  const executable = path.join(resources, "../ZCode.exe");
  try {
    const stat = fs.statSync(executable);
    const key = JSON.stringify([executable, stat.size, stat.mtimeMs]);
    if (lastWindowsVersion?.key === key) return lastWindowsVersion.version;
    const powershell = path.join(process.env.SystemRoot || "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe");
    const result = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-Command",
      "(Get-Item -LiteralPath $env:ZCODE_BRIDGE_VERSION_TARGET -ErrorAction Stop).VersionInfo.ProductVersion"], {
      env: { ...process.env, ZCODE_BRIDGE_VERSION_TARGET: executable },
      encoding: "utf8", timeout: 2500, maxBuffer: 16_384, windowsHide: true,
    });
    const version = result.status === 0 && /^(\d{1,6}\.\d{1,6}\.\d{1,6})(?:\.\d{1,6})?$/.exec(result.stdout.trim())?.[1];
    if (!version) return null;
    lastWindowsVersion = { key, version };
    return version;
  } catch { return null; }
}

export function desktopVersion(entry) {
  if (!entry) return null;
  const resources = path.dirname(path.dirname(entry));
  const version = packedVersion(resources);
  if (version) return version;
  if (process.platform === "win32") return windowsExecutableVersion(resources);
  if (process.platform !== "darwin") return null;
  try {
    const info = fs.readFileSync(path.join(resources, "../Info.plist"), "utf8");
    const installed = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(info)?.[1];
    return desktopVersionPattern.test(installed) ? installed : null;
  } catch { return null; }
}

// Resolve on the selected host for chat, model discovery, usage and diagnostics.
// An explicit path remains authoritative, including when that path is missing.
export function nativeEnvironment(dataDir, override = "", env = process.env, platform = process.platform) {
  const entry = override?.trim() || env.ZCODE_NATIVE_ENTRY || installedDesktop(dataDir, platform, env);
  return {
    ...(entry ? { ZCODE_NATIVE_ENTRY: entry } : {}),
    // ACP 0.3.2 cannot select Linux Electron. BB already supplies a Node runtime;
    // use it for the Linux CLI without installing Node or modifying ZCode files.
    ...(platform === "linux" && !env.ZCODE_NODE ? { ZCODE_NODE: process.execPath } : {}),
  };
}
