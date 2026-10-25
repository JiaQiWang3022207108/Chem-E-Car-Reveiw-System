import SevenZip from "7z-wasm";
import sevenZipModule from "7z-wasm/7zz.wasm?module";
import {readSevenZipEntries} from "./sevenzip-core";

export function readUnicodeArchive(bytes: Uint8Array) {
  return readSevenZipEntries(bytes, options => SevenZip({
    ...options,
    // Cloudflare requires precompiled modules; no dynamic code or remote fetch.
    instantiateWasm(imports: WebAssembly.Imports, receive: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void) {
      const instance = new WebAssembly.Instance(sevenZipModule, imports);
      receive(instance, sevenZipModule);
      return instance.exports;
    },
  } as Parameters<typeof SevenZip>[0]));
}
