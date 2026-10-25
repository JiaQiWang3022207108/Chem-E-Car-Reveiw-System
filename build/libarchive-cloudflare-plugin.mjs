const LIBARCHIVE_MODULE_SUFFIX = "/node_modules/libarchive-wasm/dist/libarchive.js";

const WORKER_ENVIRONMENT_CHECK =
  'ENVIRONMENT_IS_WORKER = typeof WorkerGlobalScope != "undefined";';
const NODE_ENVIRONMENT_CHECK =
  'ENVIRONMENT_IS_NODE = typeof process == "object" && typeof process.versions == "object" && typeof process.versions.node == "string" && process.type != "renderer";';
const WORKER_SCRIPT_URL = 'scriptDirectory = self.location.href;';

/**
 * libarchive-wasm's generated Emscripten loader treats the presence of
 * `process.versions.node` as proof that it is running in Node. Cloudflare's
 * `nodejs_compat` intentionally exposes that object, although Worker modules
 * do not provide CommonJS globals such as `__dirname` or `require`.
 *
 * Scope the correction to this one generated dependency so the rest of the
 * Worker can continue to use nodejs_compat normally.
 */
export function cloudflareLibarchivePlugin() {
  return {
    name: "chemecar-libarchive-cloudflare-runtime",
    enforce: "pre",
    transform(code, id) {
      const normalizedId = id.split("?", 1)[0].replaceAll("\\", "/");
      if (!normalizedId.endsWith(LIBARCHIVE_MODULE_SUFFIX)) return null;

      if (
        !code.includes(WORKER_ENVIRONMENT_CHECK) ||
        !code.includes(NODE_ENVIRONMENT_CHECK) || !code.includes(WORKER_SCRIPT_URL)
      ) {
        throw new Error(
          "libarchive-wasm runtime checks changed; review the Cloudflare transform before building.",
        );
      }

      return {
        code: code
          .replace(WORKER_ENVIRONMENT_CHECK, "ENVIRONMENT_IS_WORKER = true;")
          .replace(NODE_ENVIRONMENT_CHECK, "ENVIRONMENT_IS_NODE = false;")
          // Worker modules receive the compiled WASM via instantiateWasm;
          // there is no script URL to fetch and Cloudflare has no location.
          .replace(WORKER_SCRIPT_URL, 'scriptDirectory = "";'),
        map: null,
      };
    },
  };
}
