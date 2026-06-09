import { defineConfig, devices } from '@playwright/test';

// Critical-journey E2E on the served web build. WebKit approximates iOS WKWebView.
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [['html'], ['github']] : 'list',
  use: {
    baseURL: process.env.BASE_URL || 'http://localhost:4173',
    trace: 'on-first-retry',
  },
  webServer: {
    command: 'npm run build && npm run preview',
    url: process.env.BASE_URL || 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } }, // iOS WKWebView proxy
  ],
});
