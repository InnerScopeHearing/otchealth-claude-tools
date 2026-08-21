// Guards the pure classification logic behind skills/aws-image-canary/image-canary.mjs -- the canary
// that catches a scheduled ECS task whose pinned image tag has aged out of its ECR repo's lifecycle
// policy (see FND-20260821-29e2). Mirrors tests/azure-canary-freshness.test.mjs /
// tests/nightly-schedule-canary.test.mjs's discipline: the pure classification + exit-code logic is
// hermetically tested with no AWS credentials or network access at all. Fixtures below are the EXACT
// response shapes live-verified 2026-08-21 against the real otchealth-mcp-gateway ECR repository.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseImageRef,
  classifyDescribeImagesResponse,
  taskDefinitionRefKind,
  selectCountRules,
  isPreciselyModelable,
  rankByTag,
  slotsRemaining,
  assessLeadingIndicator,
  pageExitCode,
} from "../skills/aws-image-canary/image-canary.mjs";

test("parseImageRef: a tagged private ECR image parses cleanly", () => {
  const r = parseImageRef("900915535335.dkr.ecr.us-east-1.amazonaws.com/otchealth-mcp-gateway:b18c5a3");
  assert.equal(r.isEcr, true);
  assert.equal(r.repository, "otchealth-mcp-gateway");
  assert.equal(r.tag, "b18c5a3");
  assert.equal(r.digest, null);
});

test("parseImageRef: a digest-pinned ECR image captures the digest and no tag", () => {
  const digest = "sha256:" + "a".repeat(64);
  const r = parseImageRef(`900915535335.dkr.ecr.us-east-1.amazonaws.com/otchealth-mcp-gateway@${digest}`);
  assert.equal(r.isEcr, true);
  assert.equal(r.tag, null);
  assert.equal(r.digest, digest);
});

test("parseImageRef: a bare ECR repo with no tag defaults to latest, matching Docker convention", () => {
  const r = parseImageRef("900915535335.dkr.ecr.us-east-1.amazonaws.com/otchealth-mcp-gateway");
  assert.equal(r.isEcr, true);
  assert.equal(r.tag, "latest");
});

test("parseImageRef: the public ECR gallery is NOT this account's private repo lifecycle scope", () => {
  const r = parseImageRef("public.ecr.aws/otchealth/some-tool:v1");
  assert.equal(r.isEcr, false);
  assert.match(r.reason, /public ECR gallery/);
});

test("parseImageRef: Docker Hub / any other registry is out of scope, not an anomaly", () => {
  assert.equal(parseImageRef("redis:7").isEcr, false);
  assert.equal(parseImageRef("nginx").isEcr, false);
});

test("parseImageRef: empty/non-string image fields never throw", () => {
  assert.equal(parseImageRef("").isEcr, false);
  assert.equal(parseImageRef(null).isEcr, false);
  assert.equal(parseImageRef(undefined).isEcr, false);
});

test("classifyDescribeImagesResponse: a live image is RESOLVED", () => {
  const body = { imageDetails: [{ imageDigest: "sha256:abc", imageTags: ["b18c5a3"], imagePushedAt: 1787109743.563 }] };
  assert.equal(classifyDescribeImagesResponse(200, body).state, "RESOLVED");
});

test("classifyDescribeImagesResponse: THE incident -- a dead tag is NOT_FOUND (live-verified shape)", () => {
  // The exact body ECR returned 2026-08-21 for the real, already-expired tag "28f3d25".
  const body = { __type: "ImageNotFoundException", message: "The image with imageId {imageDigest:'null', imageTag:'28f3d25'} does not exist within the repository with name 'otchealth-mcp-gateway' in the registry with id '900915535335'" };
  const v = classifyDescribeImagesResponse(400, body);
  assert.equal(v.state, "NOT_FOUND");
});

test("classifyDescribeImagesResponse: a deleted repository is REPO_NOT_FOUND, a distinct state (live-verified shape)", () => {
  const body = { __type: "RepositoryNotFoundException", message: "The repository with name 'this-repo-does-not-exist-xyz' does not exist in the registry with id '900915535335'" };
  assert.equal(classifyDescribeImagesResponse(400, body).state, "REPO_NOT_FOUND");
});

test("classifyDescribeImagesResponse: an unrelated error (e.g. AccessDenied, 5xx) is QUERY_ERROR, never a silent pass", () => {
  assert.equal(classifyDescribeImagesResponse(403, { __type: "AccessDeniedException", message: "nope" }).state, "QUERY_ERROR");
  assert.equal(classifyDescribeImagesResponse(500, {}).state, "QUERY_ERROR");
});

test("classifyDescribeImagesResponse: an unexpected empty 200 is QUERY_ERROR, not read as a pass", () => {
  assert.equal(classifyDescribeImagesResponse(200, { imageDetails: [] }).state, "QUERY_ERROR");
});

test("taskDefinitionRefKind: a trailing :N is a pinned revision", () => {
  assert.equal(taskDefinitionRefKind("arn:aws:ecs:us-east-1:900915535335:task-definition/otchealth-job-otchealth-mcp-eval:4"), "PINNED_REVISION");
});

test("taskDefinitionRefKind: no trailing :N is a floating-latest family reference", () => {
  assert.equal(taskDefinitionRefKind("arn:aws:ecs:us-east-1:900915535335:task-definition/otchealth-job-otchealth-mcp-eval"), "FLOATING_LATEST");
  assert.equal(taskDefinitionRefKind("otchealth-job-otchealth-mcp-eval"), "FLOATING_LATEST");
});

test("taskDefinitionRefKind: a missing ARN never throws", () => {
  assert.equal(taskDefinitionRefKind(null), "UNKNOWN");
  assert.equal(taskDefinitionRefKind(""), "UNKNOWN");
});

test("selectCountRules: the exact live otchealth-mcp-gateway policy parses to one imageCountMoreThan rule", () => {
  const text = JSON.stringify({ rules: [{ rulePriority: 1, description: "keep last 10 images", selection: { tagStatus: "any", countType: "imageCountMoreThan", countNumber: 10 }, action: { type: "expire" } }] });
  const rules = selectCountRules(text);
  assert.equal(rules.length, 1);
  assert.equal(rules[0].countNumber, 10);
  assert.equal(rules[0].tagStatus, "any");
});

test("selectCountRules: a sinceImagePushed (time-based) rule is not returned as a count rule", () => {
  const text = JSON.stringify({ rules: [{ rulePriority: 1, selection: { tagStatus: "untagged", countType: "sinceImagePushed", countUnit: "days", countNumber: 14 }, action: { type: "expire" } }] });
  assert.deepEqual(selectCountRules(text), []);
});

test("selectCountRules: no policy or malformed JSON returns [], never throws", () => {
  assert.deepEqual(selectCountRules(null), []);
  assert.deepEqual(selectCountRules("{not json"), []);
});

test("isPreciselyModelable: tagStatus any with no tagPrefixList is modelable (the real incident's shape)", () => {
  assert.equal(isPreciselyModelable({ tagStatus: "any", tagPrefixList: null, countNumber: 10 }), true);
});

test("isPreciselyModelable: a tagPrefixList or tagStatus:tagged is deliberately NOT modeled (would need a subset rank)", () => {
  assert.equal(isPreciselyModelable({ tagStatus: "any", tagPrefixList: ["release-"], countNumber: 10 }), false);
  assert.equal(isPreciselyModelable({ tagStatus: "tagged", tagPrefixList: null, countNumber: 10 }), false);
});

test("rankByTag + slotsRemaining: the live otchealth-mcp-gateway snapshot (2026-08-21) -- newest tag ranks 1st, 9 slots remaining", () => {
  // The exact 10-image snapshot read live from the real repository.
  const images = [
    { imageTags: ["b18c5a3"], imagePushedAt: 1787198543.563 },
    { imageTags: ["8135995"], imagePushedAt: 1787187870.062 },
    { imageTags: ["de916a1"], imagePushedAt: 1787184291.233 },
    { imageTags: ["a3bcc66"], imagePushedAt: 1787128521.651 },
    { imageTags: ["a2045fc"], imagePushedAt: 1787111017.775 },
    { imageTags: ["c72dd3b"], imagePushedAt: 1787106524.870 },
    { imageTags: ["c34f97e"], imagePushedAt: 1787102171.228 },
    { imageTags: ["c92dde8"], imagePushedAt: 1787096851.481 },
    { imageTags: ["84b9bbb"], imagePushedAt: 1787096048.412 },
    { imageTags: ["2d2fe9a"], imagePushedAt: 1787094467.778 },
  ];
  const rule = { countNumber: 10, tagStatus: "any", tagPrefixList: null };
  assert.equal(rankByTag(images, "b18c5a3"), 1);
  assert.equal(slotsRemaining(rankByTag(images, "b18c5a3"), rule), 9);
  assert.equal(rankByTag(images, "2d2fe9a"), 10); // the oldest of the kept 10
  assert.equal(slotsRemaining(10, rule), 0); // the very next push expires it
});

test("rankByTag: a tag absent from the image list is null, not a false rank (NOT_FOUND already covers this case)", () => {
  assert.equal(rankByTag([{ imageTags: ["a"], imagePushedAt: 1 }], "28f3d25"), null);
});

test("slotsRemaining: no rank or no rule never throws, returns null", () => {
  assert.equal(slotsRemaining(null, { countNumber: 10 }), null);
  assert.equal(slotsRemaining(1, null), null);
});

test("assessLeadingIndicator: threshold classification (SAFE / CLOSE_TO_EXPIRY / already past rank)", () => {
  assert.equal(assessLeadingIndicator(9, 3), "SAFE");
  assert.equal(assessLeadingIndicator(3, 3), "CLOSE_TO_EXPIRY"); // exactly at the threshold is still a warning
  assert.equal(assessLeadingIndicator(0, 3), "CLOSE_TO_EXPIRY");
  assert.equal(assessLeadingIndicator(-1, 3), "LIKELY_EXPIRED_PENDING_EVALUATION");
  assert.equal(assessLeadingIndicator(null, 3), "N/A");
});

test("pageExitCode: strict + a live anomaly pages (exit 1)", () => {
  assert.equal(pageExitCode(1, true), 1);
});

test("pageExitCode: strict + zero anomalies does not page (exit 0)", () => {
  assert.equal(pageExitCode(0, true), 0);
});

test("pageExitCode: non-strict never pages, even with anomalies (report-only default)", () => {
  assert.equal(pageExitCode(4, false), 0);
  assert.equal(pageExitCode(0, false), 0);
});
