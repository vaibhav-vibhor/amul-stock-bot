import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

export function runCheck(execute = spawnSync) {
  const npm = process.env.npm_execpath;
  if (!npm) {
    console.error("Run this gate with npm run check.");
    return 1;
  }
  const stages = [
    [npm, "run", "typecheck"],
    ["--check", "scripts/telegram-setup.mjs"],
    [npm, "test"],
    [npm, "run", "build"],
  ];
  for (const args of stages) {
    const result = execute(process.execPath, args, {
      cwd: root,
      stdio: "inherit",
      env: {
        ...process.env,
        WRANGLER_SEND_METRICS: "false",
        WRANGLER_WRITE_LOGS: "false",
        // The banner performs an npm version lookup, even on a dry-run build.
        WRANGLER_HIDE_BANNER: "true",
      },
    });
    if (result.error) {
      console.error(`Check could not start: ${result.error.message}`);
      return 1;
    }
    if (result.status !== 0) return result.status ?? 1;
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = runCheck();
}
