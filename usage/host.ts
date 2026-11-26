import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { hostContract } from "../contract.js";
import { usageSchema } from "./contract.js";
import { selectAcp } from "../scripts/managed-acp.mjs";
import { createAcpInstaller } from "../scripts/acp-installer.mjs";
import { runJson } from "../scripts/native-cli.mjs";
import { PlanUsageCache } from "./usage-cache.mjs";
import { desktopInstallation, desktopStatus } from "../acp-contract.js";
import { withModelCatalog } from "../scripts/model-catalog.mjs";
import { createDesktopInstaller } from "../scripts/zcode-installer.mjs";
import { nativeEnvironment } from "../scripts/zcode-installation.mjs";
const cache = new PlanUsageCache();
const installers = new Map<string, ReturnType<typeof createAcpInstaller>>();
function installer(dataDir: string) {
  let value = installers.get(dataDir);
  if (!value) { value = createAcpInstaller({ dataDir }); installers.set(dataDir, value); }
  return value;
}
const desktops = new Map<string, ReturnType<typeof createDesktopInstaller>>();
function desktop(dataDir: string) {
  let value = desktops.get(dataDir);
  if (!value) { value = createDesktopInstaller({ dataDir }); desktops.set(dataDir, value); }
  return value;
}
export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    desktopInstallStatus: async ({ nativeEntry, refresh }, context) => desktopStatus.parse(await desktop(context.experimental_paths.dataDir).check(nativeEntry, refresh)),
    desktopInstall: (input, context) => {
      const instance = desktop(context.experimental_paths.dataDir);
      const lease = context.experimental_retainWorker();
      try {
        const result = instance.start({ ...input, signal: AbortSignal.any([context.lifecycle.signal, AbortSignal.timeout(15 * 60_000)]) });
        void instance.wait().finally(() => lease.dispose()).catch(() => {});
        return desktopInstallation.parse(result);
      } catch (error) { void lease.dispose(); throw error; }
    },
    acpStatus: async (input, context) => installer(context.experimental_paths.dataDir).status({ ...input, signal: AbortSignal.any([context.signal, context.lifecycle.signal, AbortSignal.timeout(40_000)]) }),
    acpInstall: async (_input, context) => installer(context.experimental_paths.dataDir).install({ signal: AbortSignal.any([context.signal, context.lifecycle.signal, AbortSignal.timeout(170_000)]) }),
    inventory: async (input, context) => {
      const acpCommand = selectAcp(context?.experimental_paths?.dataDir, input.acpCommand).executable;
      const result = await runJson(["inventory"], { ...input, acpCommand, nativeEnv: nativeEnvironment(context?.experimental_paths?.dataDir, input.nativeEntry), timeout: 8_000 }) as { schemaVersion?: number; installed?: boolean };
      if (result.schemaVersion !== 1 || typeof result.installed !== "boolean") throw new Error("Unsupported zcode-acp inventory response");
      return { installed: result.installed };
    },
    collect: async ({ plan, refresh, ...input }, context) => {
      const signal = AbortSignal.any([context.signal, context.lifecycle.signal]);
      const dataDir = context.experimental_paths.dataDir;
      const nativeEnv = await withModelCatalog(dataDir, nativeEnvironment(dataDir, input.nativeEntry));
      const options = { ...input, acpCommand: selectAcp(dataDir, input.acpCommand).executable, nativeEnv, signal };
      const account = await runJson(["account-scope"], { ...options, timeout: 8_000 }) as { schemaVersion?: number; scope?: string };
      if (account.schemaVersion !== 1 || typeof account.scope !== "string") throw new Error("Unsupported zcode-acp account response");
      const scope = JSON.stringify([options.acpCommand, options.nativeEnv.ZCODE_NATIVE_ENTRY || "", account.scope]);
      return cache.get(plan, scope, refresh, async () => usageSchema.parse(await runJson(["usage", "--plan", plan], { ...options, timeout: 55_000 })));
    },
  },
  dispose: async () => { cache.clear(); installers.clear(); desktops.clear(); },
});
