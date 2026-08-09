import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluatePages } from './aftership-s0-probe.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const baseExpected = JSON.parse(fs.readFileSync(path.join(root, 'aftership-expected.json'), 'utf8'));

function expectedWithSatisfiedDependency() {
  const expected = structuredClone(baseExpected);
  expected.vendor_dependency.dependency_satisfied = true;
  expected.vendor_dependency.tracking_app_installed = true;
  expected.vendor_dependency.tracking_app_install_authorized = true;
  expected.vendor_dependency.authorized_delivery_date_source = 'AfterShip Tracking';
  return expected;
}

function expectedWithAssignedOwners() {
  const expected = expectedWithSatisfiedDependency();
  for (const key of Object.keys(expected.notification_ownership)) {
    expected.notification_ownership[key] = `Assigned ${key}`;
  }
  return expected;
}

function pageBody({
  host = 'hearingassist.aftership.com',
  visible = 'Page not found Back to the store page',
  returnsPageStatus = 'unpublished',
  accessStatus = 'denied',
  accessCode = 'returns_page_not_published',
  windowBase = 'delivery_date',
  policyText = baseExpected.admin_expected.approved_policy_summary,
  translatedSummary = baseExpected.admin_expected.approved_policy_summary,
  policyUrl = baseExpected.admin_expected.approved_policy_url,
  blockSearch = true,
  contactUrl = 'https://otchealthmart.com/pages/contact',
  privacyUrl = 'https://otchealthmart.com/policies/privacy-policy',
  termsUrl = 'https://otchealthmart.com/policies/terms-of-service'
} = {}) {
  const data = {
    props: {
      pageProps: { isAppProxy: false },
      initialProps: {
        shopInfo: {
          store_name: 'OTCHealth Inc.',
          returns_page_status: returnsPageStatus,
          returns_page_block_search_engine: blockSearch,
          returns_page_setting_updated_at: '2026-08-09T01:01:01Z',
          return_window_base_on: windowBase,
          policy_text: policyText,
          policy_url: policyUrl,
          contact_url: contactUrl,
          privacy_url: privacyUrl,
          terms_url: termsUrl,
          default_language: 'en-US'
        },
        shopHostName: host,
        returnsPageAccess: { status: accessStatus, code: accessCode }
      },
      resources: {
        'en-US': {
          shopper: {
            'page.description.acceptReturnsPolicy': translatedSummary
          }
        }
      }
    }
  };
  return `<html><body>${visible}<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script></body></html>`;
}

function fourPages(bodyOptions = {}) {
  const domains = ['https://hearingassist.aftership.com', 'https://hearingassist.returnscenter.com'];
  const paths = ['/', '/return-policy'];
  return domains.flatMap((domain) => paths.map((suffix) => ({
    url: new URL(suffix, domain).toString(),
    status: 200,
    visible_text: bodyOptions.visible ?? 'Page not found Back to the store page',
    body: pageBody({ ...bodyOptions, host: new URL(domain).host })
  })));
}

test('fully aligned unpublished runtime passes readback but grants no launch authority', () => {
  const report = evaluatePages(expectedWithAssignedOwners(), fourPages(), '2026-08-09T00:00:00Z');
  assert.equal(report.overall, 'PASS');
  assert.equal(report.launch_decision, 'NO_AUTOMATIC_LAUNCH_AUTHORITY');
  assert.equal(report.failed_s0.length, 0);
  assert.ok(report.domain_results.every((row) => row.soft_404));
});

test('known current drift is HOLD_S0 even while visible page is a soft 404', () => {
  const pages = fourPages({
    windowBase: 'order_date',
    policyText: 'We accept returns of unused and undamaged items according to our returns policy.',
    policyUrl: 'https://otchealthmart.com/policies/refund-policy.',
    blockSearch: false,
    contactUrl: null,
    privacyUrl: null,
    termsUrl: null
  });
  const report = evaluatePages(expectedWithAssignedOwners(), pages, '2026-08-09T00:00:00Z');
  assert.equal(report.overall, 'HOLD_S0');
  assert.ok(report.failed_s0.some((id) => id.endsWith('WINDOW_BASE_MATCHES_ADMIN')));
  assert.ok(report.failed_s0.some((id) => id.endsWith('FORBIDDEN_POLICY_COPY_ABSENT')));
  assert.ok(report.failed_s0.some((id) => id.endsWith('POLICY_URL_EXACT')));
  assert.ok(report.domain_results.every((row) => row.visible_page_not_found && row.soft_404));
});

test('public order lookup leakage is S0 even if Admin says unpublished', () => {
  const pages = fourPages({
    visible: 'Start your return Find your order',
    accessStatus: 'allowed',
    accessCode: 'published'
  });
  const report = evaluatePages(expectedWithAssignedOwners(), pages, '2026-08-09T00:00:00Z');
  assert.equal(report.overall, 'HOLD_S0');
  assert.ok(report.failed_s0.some((id) => id.endsWith('VISIBLE_PUBLIC_ACCESS_DENIED')));
  assert.ok(report.failed_s0.some((id) => id.endsWith('NO_ACTIONABLE_ORDER_LOOKUP')));
  assert.ok(report.failed_s0.some((id) => id.endsWith('RUNTIME_ACCESS_DENIED')));
});

test('unassigned notification owners hold launch even when pages and runtime align', () => {
  const report = evaluatePages(expectedWithSatisfiedDependency(), fourPages(), '2026-08-09T00:00:00Z');
  assert.equal(report.overall, 'HOLD_S1');
  assert.ok(report.alerts.includes('NOTIFICATION_OWNERSHIP_INCOMPLETE'));
  assert.ok(report.unassigned_notification_owners.length >= 1);
});

test('approved translated summary is parsed from props.resources', () => {
  const report = evaluatePages(expectedWithAssignedOwners(), fourPages(), '2026-08-09T00:00:00Z');
  const check = report.domain_results[0].checks.find((item) => item.id === 'APPROVED_POLICY_SUMMARY_PRESENT');
  assert.equal(check.pass, true);
});

test('unsatisfied Tracking dependency is S0 even if public runtime otherwise aligns', () => {
  const expected = structuredClone(baseExpected);
  for (const key of Object.keys(expected.notification_ownership)) expected.notification_ownership[key] = `Assigned ${key}`;
  const report = evaluatePages(expected, fourPages(), '2026-08-09T00:00:00Z');
  assert.equal(report.overall, 'HOLD_S0');
  assert.ok(report.failed_s0.includes('GLOBAL:DELIVERY_DATE_VENDOR_DEPENDENCY_UNSATISFIED'));
  assert.equal(report.vendor_dependency.delivery_date_basis_requires_app, 'AfterShip Tracking');
  assert.equal(report.vendor_dependency.order_date_approximation_permitted, false);
});

test('daily S0, notification ownership and launch addendum carry the mandatory drift controls', () => {
  const daily = fs.readFileSync(path.join(root, 'DAILY-S0-AFTERSHIP-CHECKLIST.md'), 'utf8');
  const notifications = fs.readFileSync(path.join(root, 'NOTIFICATION-OWNERSHIP-MATRIX.md'), 'utf8');
  const launch = fs.readFileSync(path.join(root, 'LAUNCH-CHECKLIST-ADDENDUM.md'), 'utf8');
  const procurement = fs.readFileSync(path.join(root, 'AFTERSHIP-TRACKING-PROCUREMENT-SCOPE-GATE.md'), 'utf8');
  for (const required of ['hearingassist.aftership.com', 'hearingassist.returnscenter.com', 'return_window_base_on', 'soft 404', '75 days', 'policy URL']) {
    assert.ok(daily.toLowerCase().includes(required.toLowerCase()), `daily S0 missing ${required}`);
  }
  for (const required of ['configuration owner', 'content owner', 'release authority', 'rejection/adverse', 'safety/stop-use', 'wrong-recipient']) {
    assert.ok(notifications.toLowerCase().includes(required.toLowerCase()), `notification matrix missing ${required}`);
  }
  for (const required of ['two consecutive clean daily readbacks', 'runtime `return_window_base_on`', 'search-engine blocking', 'contact, privacy and terms', 'AfterShip Tracking', 'order-date approximation']) {
    assert.ok(launch.toLowerCase().includes(required.toLowerCase()), `launch checklist missing ${required}`);
  }
  for (const required of ['Try for free', 'Save is disabled', 'Order date is not an acceptable approximation', 'Shopify scopes', 'trial conversion', 'uninstall', 'recurring spend']) {
    assert.ok(procurement.toLowerCase().includes(required.toLowerCase()), `procurement gate missing ${required}`);
  }
});
