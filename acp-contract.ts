import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
const hostId = z.string().min(1);
const installation = z.object({ version: z.string(), executable: z.string() });
export const desktopInstallation = z.object({
  phase: z.enum(["idle", "resolving", "downloading", "verifying", "installing", "installed", "failed"]),
  downloaded: z.number().nonnegative(), total: z.number().nonnegative(),
  version: z.string().nullable(), entry: z.string().nullable(), error: z.string().nullable(),
});
export const desktopStatus = desktopInstallation.extend({
  currentVersion: z.string().nullable(), currentEntry: z.string().nullable(),
  latestVersion: z.string().nullable(), releaseError: z.string().nullable(),
  updateAvailable: z.boolean(), canUpdate: z.boolean(), customPath: z.boolean(),
});
export const acpStatus = z.object({
  target: z.string().nullable(),
  current: installation.extend({ source: z.enum(["custom", "managed", "path"]) }).nullable(),
  currentError: z.string().nullable(),
  managed: installation.nullable(),
  latest: z.object({ version: z.string(), ready: z.boolean() }).nullable(),
  releaseError: z.string().nullable(),
  releasesUrl: z.string(),
});
export const acpRpcContract = defineRpcContract({
  "acp.hosts": { input: z.object({}), output: z.object({ hosts: z.array(z.object({ id: hostId, name: z.string(), connected: z.boolean() })) }) },
  "acp.status": { input: z.object({ hostId, refresh: z.boolean() }), output: acpStatus },
  "zcode.install": { input: z.object({ hostId, upgrade: z.boolean().optional() }), output: desktopInstallation },
  "zcode.installStatus": { input: z.object({ hostId, refresh: z.boolean().optional() }), output: desktopStatus },
  "zcode.refreshModels": { input: z.object({ hostId }), output: z.object({ ok: z.literal(true) }) },
  "acp.install": { input: z.object({ hostId }), output: installation },
  "acp.useManaged": { input: z.object({ hostId }), output: z.object({ ok: z.literal(true) }) },
});
export const acpHostContract = defineRpcContract({
  acpStatus: { input: z.object({ acpCommand: z.string(), refresh: z.boolean() }), output: acpStatus },
  desktopInstall: { input: z.object({ nativeEntry: z.string(), upgrade: z.boolean().optional() }), output: desktopInstallation },
  desktopInstallStatus: { input: z.object({ nativeEntry: z.string(), refresh: z.boolean().optional() }), output: desktopStatus },
  acpInstall: { input: z.object({}), output: installation },
});
