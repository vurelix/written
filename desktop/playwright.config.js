// Smoke harness config (implementation plan rev.8 §D3).
//
// The logic suite (../test/written.logic.test.cjs) runs the x-dc block in a Node vm:
// no DOM, no CSS engine. It therefore cannot see malformed DC markup, dropped CSS
// declarations, focus behaviour or geometry — which is most of what the UI work in
// sprints 2-7 produces. This suite is the only automated check that can.
'use strict';

const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './test',
  testMatch: '**/*.spec.js',
  // Deterministic geometry assertions cannot survive parallel viewport churn.
  workers: 1,
  fullyParallel: false,
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    // The built renderer is loaded over file:// so the injected CSP is exercised
    // exactly as it ships.
    baseURL: undefined,
  },
});
