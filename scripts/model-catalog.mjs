import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { desktopVersion } from "./zcode-installation.mjs";

const refreshAfter = 60 * 60 * 1000;
const retryAfter = 60 * 1000;
const pending = new Map();
const retryAt = new Map();
const maxBytes = 10 * 1024 * 1024;

async function getJson(url, signal, fetchImpl) {
  const response = await fetchImpl(url, { signal, redirect: "error" });
  if (!response.ok || !response.body) throw new Error("Model catalog unavailable");
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maxBytes) throw new Error("Model catalog exceeds size limit");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function validCatalog(value) {
  const rules = value?.config?.providerConfigRules?.providerRules;
  return value?.schemaVersion === 1 && Number.isSafeInteger(value.revision) && value.revision >= 0 &&
    Array.isArray(value.config.modelConfigRules?.modelRules) && Array.isArray(rules) && rules.length > 0 &&
    rules.every(rule => typeof rule.providerId === "string" && rule.providerId &&
      Array.isArray(rule.config?.builtinModelIds) && rule.config.builtinModelIds.every(id => typeof id === "string" && id));
}

async function readCatalog(file) {
  try {
    const stat = await fs.stat(file);
    if (stat.size > maxBytes) return null;
    const value = JSON.parse(await fs.readFile(file, "utf8"));
    return validCatalog(value) ? { value, mtime: stat.mtimeMs } : null;
  } catch { return null; }
}

async function refresh(file, bundled, version, platform, fetchImpl) {
  const fallback = await readCatalog(file);
  const usable = fallback && fallback.value.revision >= bundled.revision;
  if (usable && Date.now() - fallback.mtime < refreshAfter) return file;
  if ((retryAt.get(file) ?? 0) > Date.now()) return usable ? file : null;
  let temporary;
  try {
    const signal = AbortSignal.timeout(3_000);
    const query = new URLSearchParams({ app_version: version, platform });
    const configs = await getJson(`https://zcode.z.ai/api/v1/client/configs?${query}`, signal, fetchImpl);
    const url = new URL(configs?.data?.configs?.builtin_provider_config_json);
    if (configs.code !== 0 || url.origin !== "https://cdn-zcode.z.ai" || url.username || url.password ||
        url.search || url.hash || !/^\/zcode\/config\/[\w.-]+\.json$/.test(url.pathname)) {
      throw new Error("Unrecognized ZCode catalog URL");
    }
    const catalog = await getJson(url, signal, fetchImpl);
    if (!validCatalog(catalog) || catalog.revision < bundled.revision || (usable && catalog.revision < fallback.value.revision)) {
      throw new Error("Incompatible ZCode catalog");
    }
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    temporary = `${file}-${randomUUID()}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(catalog), { mode: 0o600, flag: "wx" });
    await fs.rename(temporary, file);
    return file;
  } catch {
    retryAt.set(file, Date.now() + retryAfter);
    return usable ? file : null;
  } finally {
    if (temporary) await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

// Keep the catalog in plugin data. Both Rust entitlement checks and the
// native ZCode registry receive the same file. Custom catalog overrides win.
export async function withModelCatalog(dataDir, env, fetchImpl = fetch) {
  if (!dataDir || !env.ZCODE_NATIVE_ENTRY || env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE || process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE) return env;
  const entry = env.ZCODE_NATIVE_ENTRY;
  const version = desktopVersion(entry);
  if (!version) return env;
  const platform = process.platform === "win32" ? "windows" : process.platform;
  const arch = { x64: "x86_64", arm64: "aarch64" }[process.arch] ?? process.arch;
  const target = `${platform}-${arch}`;
  const bundledPath = path.join(path.dirname(path.dirname(entry)), "config/provider/zcode-builtin.json");
  const bundled = await readCatalog(bundledPath);
  if (!bundled) return env;
  const file = path.join(dataDir, "zcode/catalog", `${target}-${version}.json`);
  let task = pending.get(file);
  if (!task) {
    task = refresh(file, bundled.value, version, target, fetchImpl).finally(() => pending.delete(file));
    pending.set(file, task);
  }
  const catalog = await task;
  return catalog ? { ...env, ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: catalog } : env;
}
