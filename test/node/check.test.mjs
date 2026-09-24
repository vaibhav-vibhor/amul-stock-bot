import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runCheck } from "../../scripts/check.mjs";

test("the unified gate and optional real hook propagate failure without running later stages", (t) => {
  assert.ok(process.env.npm_execpath, "Node suites must run through npm test/check.");
  const npm = process.env.npm_execpath;
  const expected = [
    [npm, "run", "typecheck"],
    ["--check", "scripts/telegram-setup.mjs"],
    [npm, "test"],
    [npm, "run", "build"],
  ];
  for (const failAt of [0, 1, 2, 3, 4]) {
    const seen = [];
    const code = runCheck((executable, args, options) => {
      assert.equal(executable, process.execPath);
      assert.equal(options.env.WRANGLER_SEND_METRICS, "false");
      assert.equal(options.env.WRANGLER_WRITE_LOGS, "false");
      assert.equal(options.env.WRANGLER_HIDE_BANNER, "true");
      seen.push(args);
      return { status: seen.length === failAt ? 23 : 0 };
    });
    assert.equal(code, failAt ? 23 : 0);
    assert.deepEqual(seen, expected.slice(0, failAt || expected.length));
  }
  assert.equal(runCheck(() => ({ status: null, signal: "SIGTERM" })), 1);

  const directory = mkdtempSync(join(tmpdir(), "amul-hook-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const trace = join(directory, "called.txt");
  writeFileSync(join(directory, "npm"), '#!/bin/sh\nprintf "%s\\n" "$*" > "$CHECK_TRACE"\nexit "$CHECK_EXIT"\n', { mode: 0o755 });
  const hook = fileURLToPath(new URL("../../.githooks/pre-push", import.meta.url));
  for (const status of [23, 0]) {
    const result = spawnSync("sh", [hook], {
      cwd: directory, encoding: "utf8", timeout: 10_000,
      env: { ...process.env, PATH: `${directory}${delimiter}${process.env.PATH}`, CHECK_TRACE: trace, CHECK_EXIT: String(status) },
    });
    assert.equal(result.status, status, result.stderr);
    assert.equal(readFileSync(trace, "utf8").trim(), "run check");
  }
});
