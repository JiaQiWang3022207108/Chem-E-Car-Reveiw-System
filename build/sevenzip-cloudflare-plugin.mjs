// The 7-Zip C++ binary is provided as a compiled Worker module, never fetched
// through a Node filesystem or a browser script URL at runtime.
export function cloudflareSevenZipPlugin() {
  return {
    name: "chemecar-sevenzip-cloudflare-runtime",
    enforce: "pre",
    transform(code, id) {
      if (!id.split("?", 1)[0].replaceAll("\\", "/").endsWith("/7z-wasm/7zz.es6.js")) return null;
      const marker = 'var ENVIRONMENT_IS_NODE=typeof process=="object"&&process.versions?.node&&process.type!="renderer";';
      if (!code.includes(marker)) throw new Error("7-Zip loader changed; check the Worker adapter before building.");
      return {code: code.replace(marker, "var ENVIRONMENT_IS_NODE=false;")
        .replace('new URL("7zz.wasm",import.meta.url).href', '""'), map: null};
    },
  };
}
