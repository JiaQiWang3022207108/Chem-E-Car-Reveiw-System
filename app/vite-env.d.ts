declare module "*?url" {
  const url: string;
  export default url;
}

declare module "*.wasm?module" {
  const wasmModule: WebAssembly.Module;
  export default wasmModule;
}
