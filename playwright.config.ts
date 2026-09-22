import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./test/browser",
  use: { baseURL: "http://127.0.0.1:8173", viewport: { width: 1440, height: 1000 } },
  webServer: {
    command: "python3 -m http.server 8173 --bind 127.0.0.1 --directory public",
    url: "http://127.0.0.1:8173",
    reuseExistingServer: false,
  },
});
