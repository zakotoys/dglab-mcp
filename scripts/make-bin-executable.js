import fs from "node:fs";
import path from "node:path";

// npm records file modes at pack time; ensure the bin is 755 on Unix so the
// published package installs a directly executable launcher.
const bin = path.join(import.meta.dirname, "..", "dist", "index.js");
if (process.platform !== "win32") {
  fs.chmodSync(bin, 0o755);
}
