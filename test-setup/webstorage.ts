// localStorage / sessionStorage shim for vitest on Node >= 26.
//
// Node 26 PREDEFINES globalThis.localStorage and globalThis.sessionStorage but
// leaves them `undefined` unless the process was started with
// --localstorage-file. Vitest's populateGlobal then refuses to copy jsdom's
// perfectly good Storage onto the global, because its filter skips any key
// already present on globalThis (`if (k in global) return keysArray.includes(k)`
// — and neither name is in its KEYS list).
//
// The result is that every localStorage.* call throws "Cannot read properties
// of undefined" in a suite whose production code is fine. jsdom is not at fault
// and upgrading vitest does not help.
//
// This installs a Map-backed Storage ONLY when the global is undefined, so it
// no-ops on Node 22 CI and never shadows a working implementation.

function installStorage(name: "localStorage" | "sessionStorage"): void {
  if (typeof (globalThis as Record<string, unknown>)[name] !== "undefined") return;

  const store = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (key: string) => (store.has(String(key)) ? store.get(String(key))! : null),
    key: (index: number) => [...store.keys()][index] ?? null,
    removeItem: (key: string) => void store.delete(String(key)),
    setItem: (key: string, value: string) => void store.set(String(key), String(value)),
  };

  Object.defineProperty(globalThis, name, {
    value: storage,
    configurable: true,
    writable: true,
  });
}

installStorage("localStorage");
installStorage("sessionStorage");
