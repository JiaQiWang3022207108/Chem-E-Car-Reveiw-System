import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
const root = fileURLToPath(new URL("../", import.meta.url));
const flags = ["--target=wasm32", "-std=c++17", "-O2", "-nostdlib", "-fno-exceptions", "-fno-rtti",
  "-Wl,--no-entry", "-Wl,--export=expected_pdf_count", "-Wl,--export=package_issues",
  "-Wl,--export=review_status", "-Wl,--export=compare_metric",
  "-Wl,--initial-memory=131072", "-Wl,--max-memory=131072",
  "native/edp_core.cpp", "-o", "native/edp_core.wasm"];
let result;
if (process.platform === "win32" && !process.env.CXX) {
  // WSL is optional for RUNNING the site; only needed to rebuild C++ on a
  // Windows machine without a native LLVM toolchain. No global config edits.
  const distro = ["-d", process.env.WSL_DISTRO || "Ubuntu-24.04"];
  const converted = spawnSync("wsl.exe", [...distro, "--", "wslpath", "-a", root.replaceAll("\\", "/")], {encoding:"utf8"});
  if (converted.status !== 0) throw new Error(`C++ 工具检查失败：${converted.stderr || converted.error || converted.stdout}`);
  result = spawnSync("wsl", [...distro, "--cd", converted.stdout.trim(), "--", "clang++", ...flags], {stdio:"inherit"});
} else {
  result = spawnSync(process.env.CXX || "clang++", flags, {cwd:root, stdio:"inherit"});
}
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status || 1);
console.log("C++ core built: " + path.join(root,"native","edp_core.wasm"));
