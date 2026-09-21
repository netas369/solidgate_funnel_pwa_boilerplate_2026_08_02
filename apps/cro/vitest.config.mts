import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths(), react()],
  test: {
    environment: "jsdom",
    globals: true,
    // webstorage.ts first: on Node >= 26 the global localStorage is predefined
    // as undefined, and vitest then refuses to copy jsdom's working Storage
    // over it. Without the shim whole files die on a `localStorage.*` call in
    // production code that is perfectly fine. Same wiring as apps/funnel.
    setupFiles: ["../../test-setup/webstorage.ts", "./vitest.setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
