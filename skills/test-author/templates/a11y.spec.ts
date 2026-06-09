import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// WCAG 2.2 AA gate. List the senior-critical routes; fail the PR on any violation.
const routes = ['/', '/test', '/results', '/settings'];

for (const route of routes) {
  test(`a11y: ${route} has no WCAG 2.2 AA violations`, async ({ page }) => {
    await page.goto(route);
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });
}
