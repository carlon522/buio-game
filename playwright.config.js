'use strict';

module.exports = {
  use: {
    browserName: 'chromium',
    headless: true,
    baseURL: process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:3105',
    screenshotDir: process.env.PLAYWRIGHT_SCREENSHOT_DIR || 'test-results/playwright',
  },
  webServer: {
    command: 'node tests/playwright/static-server.js',
    port: Number(process.env.PLAYWRIGHT_PORT || 3105),
    timeout: 15000,
  },
};
