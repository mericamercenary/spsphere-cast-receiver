const { spawnSync } = require("child_process");
const path = require("path");

const files = ["show-sequence.test.js", "strip-priority.test.js", "load-diagnose.test.js", "test_player.js", "cast-load-speed.test.js"];
for (const file of files) {
  const result = spawnSync(process.execPath, [path.join(__dirname, file)], { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status == null ? 1 : result.status);
}
