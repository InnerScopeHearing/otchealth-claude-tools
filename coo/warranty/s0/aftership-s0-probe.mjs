#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      if (key === 'allow-hold') args[key] = true;
      else args[key] = argv[++i];
    }
  }
  return args;
}

function extractNextData(html) {
  const match = html.match(/<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!match) throw new Error('NEXT_DATA_NOT_FOUND');
  return JSON.parse(match[1]);
}

function getRuntime(data) {
  const props = data?.props ?? {};
  const initial = props.initialProps ?? props.pageProps?.initialProps ?? {};
  const shop = initial.shopInfo ?? {};
  const shopper = props.resources?.['en-US']?.shopper ?? initial.resources?.['en-US']?.shopper ?? {};
  return {
    shop_host_name: initial.shopHostName ?? null,
    store_name: shop.store_name ?? null,
    returns_page_status: shop.returns_page_status ?? null,
    returns_page_block_search_engine: shop.returns_page_block_search_engine ?? null,
    returns_page_setting_updated_at: shop.returns_page_setting_updated_at ?? null,
    returns_page_access_status: initial.returnsPageAccess?.status ?? null,
    returns_page_access_code: initial.returnsPageAccess?.code ?? null,
    return_window_base_on: shop.return_window_base_on ?? null,
    policy_text: shop.policy_text ?? null,
    translated_policy_summary: shopper['page.description.acceptReturnsPolicy'] ?? null,
    policy_url: shop.policy_url ?? null,
    contact_url: shop.contact_url ?? null,
    privacy_url: shop.privacy_url ?? null,
    terms_url: shop.terms_url ?? null,
    default_language: shop.default_language ?? null,
    order_lookup_methods: initial.order_lookup ?? null
  };
}

function addCheck(checks, id, pass, severity, observed, expected, owner) {
  checks.push({ id, pass: Boolean(pass), severity, observed, expected, owner });
}

export function evaluatePages(expected, pages, observedAt = new Date().toISOString()) {
  const domainResults = [];
  const globalAlerts = [];
  for (const page of pages) {
    const checks = [];
    let runtime = null;
    let parseError = null;
    try {
      runtime = getRuntime(extractNextData(page.body));
    } catch (error) {
      parseError = error.message;
    }
    const bodyText = page.body;
    const visiblePageNotFound = /Page not found/i.test(bodyText);
    const soft404 = page.status === 200 && visiblePageNotFound;
    const runtimeTexts = runtime ? [runtime.policy_text, runtime.translated_policy_summary].filter(Boolean) : [];
    const forbiddenHits = expected.public_expected.forbidden_policy_phrases.filter((phrase) =>
      runtimeTexts.some((text) => text.toLowerCase().includes(phrase.toLowerCase()))
    );
    const approvedSummaryPresent = runtimeTexts.some((text) =>
      text.includes(expected.admin_expected.approved_policy_summary)
    );
    const rootPath = new URL(page.url).pathname === '/';

    addCheck(checks, 'HTTP_RESPONSE', page.status >= 200 && page.status < 500, 'S0', page.status, '2xx-4xx readable', 'Warranty Operations');
    addCheck(checks, 'VISIBLE_PUBLIC_ACCESS_DENIED', visiblePageNotFound, 'S0', visiblePageNotFound, true, 'Warranty Operations');
    addCheck(checks, 'NO_ACTIONABLE_ORDER_LOOKUP', visiblePageNotFound && !/Start your return|Find your order/i.test(page.visible_text ?? ''), 'S0', page.visible_text ?? null, 'Page not found only', 'Warranty Operations');
    addCheck(checks, 'RUNTIME_PARSEABLE', runtime !== null, 'S0', parseError, null, 'Warranty Operations');
    if (runtime) {
      addCheck(checks, 'RUNTIME_STATUS_UNPUBLISHED', runtime.returns_page_status === expected.admin_expected.returns_page_status, 'S0', runtime.returns_page_status, expected.admin_expected.returns_page_status, 'Care Team admin 11167146');
      addCheck(checks, 'RUNTIME_ACCESS_DENIED', runtime.returns_page_access_status === expected.public_expected.returns_page_access_status && runtime.returns_page_access_code === expected.public_expected.returns_page_access_code, 'S0', { status: runtime.returns_page_access_status, code: runtime.returns_page_access_code }, { status: expected.public_expected.returns_page_access_status, code: expected.public_expected.returns_page_access_code }, 'Warranty Operations');
      addCheck(checks, 'WINDOW_BASE_MATCHES_ADMIN', runtime.return_window_base_on === expected.admin_expected.return_window_base_on, 'S0', runtime.return_window_base_on, expected.admin_expected.return_window_base_on, 'Care Team admin 11167146');
      addCheck(checks, 'APPROVED_POLICY_SUMMARY_PRESENT', approvedSummaryPresent, 'S0', runtimeTexts, expected.admin_expected.approved_policy_summary, 'Care/Communications');
      addCheck(checks, 'FORBIDDEN_POLICY_COPY_ABSENT', forbiddenHits.length === 0, 'S0', forbiddenHits, [], 'Care/Communications');
      addCheck(checks, 'POLICY_URL_EXACT', runtime.policy_url === expected.admin_expected.approved_policy_url, 'S0', runtime.policy_url, expected.admin_expected.approved_policy_url, 'Care Team admin 11167146');
      addCheck(checks, 'SEARCH_ENGINE_BLOCK_WHILE_UNPUBLISHED', runtime.returns_page_block_search_engine === true, 'S1', runtime.returns_page_block_search_engine, true, 'Care Team admin 11167146');
      if (rootPath) {
        addCheck(checks, 'CONTACT_URL_SET', Boolean(runtime.contact_url), 'S1', runtime.contact_url, expected.launch_required_links.contact_url, 'Care/Communications');
        addCheck(checks, 'PRIVACY_URL_SET', Boolean(runtime.privacy_url), 'S1', runtime.privacy_url, expected.launch_required_links.privacy_url, 'Privacy');
        addCheck(checks, 'TERMS_URL_SET', Boolean(runtime.terms_url), 'S1', runtime.terms_url, expected.launch_required_links.terms_url, 'Legal');
      }
    }

    const failed = checks.filter((check) => !check.pass);
    domainResults.push({
      url: page.url,
      http_status: page.status,
      response_sha256: crypto.createHash('sha256').update(page.body).digest('hex'),
      visible_page_not_found: visiblePageNotFound,
      soft_404: soft404,
      runtime,
      checks,
      failed_check_ids: failed.map((check) => check.id),
      status: failed.some((check) => check.severity === 'S0') ? 'HOLD_S0' : failed.length ? 'HOLD_S1' : 'PASS'
    });
  }

  const globalS0 = [];
  const vendorDependency = expected.vendor_dependency ?? null;
  if (vendorDependency && vendorDependency.dependency_satisfied !== true) {
    globalS0.push('GLOBAL:DELIVERY_DATE_VENDOR_DEPENDENCY_UNSATISFIED');
  }
  const runtimeUsesOrderDate = domainResults.some((result) => result.runtime?.return_window_base_on === 'order_date');
  if (vendorDependency && vendorDependency.order_date_approximation_permitted === false && runtimeUsesOrderDate) {
    globalS0.push('GLOBAL:ORDER_DATE_APPROXIMATION_PROHIBITED');
  }

  const notificationEntries = Object.entries(expected.notification_ownership);
  const unassignedNotificationOwners = notificationEntries
    .filter(([, value]) => /UNASSIGNED/.test(String(value)))
    .map(([key]) => key);
  if (unassignedNotificationOwners.length) globalAlerts.push('NOTIFICATION_OWNERSHIP_INCOMPLETE');

  const failedS0 = [
    ...globalS0,
    ...domainResults.flatMap((result) => result.checks.filter((check) => !check.pass && check.severity === 'S0').map((check) => `${result.url}:${check.id}`))
  ];
  const failedS1 = domainResults.flatMap((result) => result.checks.filter((check) => !check.pass && check.severity === 'S1').map((check) => `${result.url}:${check.id}`));
  const overall = failedS0.length ? 'HOLD_S0' : (failedS1.length || globalAlerts.length) ? 'HOLD_S1' : 'PASS';
  return {
    report_type: 'aftership_daily_s0_readback',
    observed_at: observedAt,
    read_only: true,
    external_writes: 0,
    customer_contacts: 0,
    domains_checked: domainResults.length,
    domain_results: domainResults,
    vendor_dependency: vendorDependency,
    notification_ownership: expected.notification_ownership,
    unassigned_notification_owners: unassignedNotificationOwners,
    alerts: globalAlerts,
    failed_s0: failedS0,
    failed_s1: failedS1,
    overall,
    launch_decision: overall === 'PASS' ? 'NO_AUTOMATIC_LAUNCH_AUTHORITY' : 'HOLD_NO_GO',
    rule: expected.hard_rule
  };
}

async function fetchPages(expected) {
  const pages = [];
  for (const domain of expected.domains) {
    for (const suffix of expected.paths) {
      const url = new URL(suffix, domain).toString();
      const response = await fetch(url, {
        redirect: 'follow',
        headers: { 'user-agent': 'OTCHealth-Warranty-S0-Readback/1.0' }
      });
      const body = await response.text();
      const visibleText = body
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 500);
      pages.push({ url: response.url, status: response.status, body, visible_text: visibleText });
    }
  }
  return pages;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const expectedPath = path.resolve(args.expected ?? path.join(root, 'aftership-expected.json'));
  const expected = JSON.parse(fs.readFileSync(expectedPath, 'utf8'));
  let pages;
  if (args.fixture) pages = JSON.parse(fs.readFileSync(path.resolve(args.fixture), 'utf8')).pages;
  else pages = await fetchPages(expected);
  const report = evaluatePages(expected, pages);
  const outputPath = path.resolve(args.output ?? path.join(root, 'evidence', 'aftership-s0-latest.json'));
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({
    overall: report.overall,
    launch_decision: report.launch_decision,
    domains_checked: report.domains_checked,
    failed_s0: report.failed_s0,
    failed_s1: report.failed_s1,
    unassigned_notification_owners: report.unassigned_notification_owners,
    output: outputPath
  }, null, 2));
  if (!args['allow-hold'] && report.overall !== 'PASS') process.exit(2);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(JSON.stringify({ overall: 'ERROR', error: error.message }, null, 2));
    process.exit(1);
  });
}
