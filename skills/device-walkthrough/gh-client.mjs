// gh-client.mjs -- GitHub REST calls for the device-walkthrough skill (workflow dispatch, run
// polling, artifact listing/download). All IO.
//
// Auth reuses the fleet's org-owned GitHub App identity (skills/github-app/gh-app.mjs) at 15k
// req/hr, imported directly rather than shelled out to -- gh-app.mjs never calls process.exit() and
// exports installationToken() for exactly this. Artifact download follows the SAME "302 without the
// bearer" pattern already proven working in this fleet (skills/github-app's sibling helper): the
// short-lived Authorization header is only valid for api.github.com, and re-sending it to the
// redirected (pre-signed, unauthenticated) blob-storage URL gets rejected.
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { installationToken } from "../github-app/gh-app.mjs";

const API = "https://api.github.com";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function ghFetch(method, path, token) {
  const url = path.startsWith("http") ? path : `${API}${path}`;
  const res = await fetch(url, { method, headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" } });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, ok: res.ok, json, text };
}

/** POST /repos/{owner}/{repo}/actions/workflows/{workflow}/dispatches. Returns the dispatch
 *  timestamp (ISO string) the caller should hand to pickDispatchedRun() / findDispatchedRun(). */
export async function dispatchWorkflow({ owner, repo, workflow, ref }) {
  const { token } = await installationToken();
  const before = new Date().toISOString();
  const url = `${API}/repos/${owner}/${repo}/actions/workflows/${workflow}/dispatches`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json" },
    body: JSON.stringify({ ref }),
  });
  if (res.status !== 204) {
    const text = await res.text().catch(() => "");
    throw new Error(`workflow_dispatch failed for ${owner}/${repo} ${workflow}@${ref}: ${res.status} ${text.slice(0, 300)}`);
  }
  return before;
}

/** Polls the workflow's run list until a run created at/after `dispatchIso` shows up. Returns the
 *  run object (status, conclusion, id, html_url, ...). */
export async function findDispatchedRun({ owner, repo, workflow, dispatchIso }, { timeoutMs = 60 * 1000, intervalMs = 4000, pick } = {}) {
  const { token } = await installationToken();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = await ghFetch("GET", `/repos/${owner}/${repo}/actions/workflows/${workflow}/runs?event=workflow_dispatch&per_page=10`, token);
    if (r.ok && r.json?.workflow_runs) {
      const found = pick(r.json.workflow_runs, dispatchIso);
      if (found) return found;
    }
    if (Date.now() >= deadline) throw new Error(`no ${owner}/${repo} ${workflow} run appeared within ${timeoutMs}ms of dispatch`);
    await sleep(intervalMs);
  }
}

/** Polls a run by id until status === "completed". Returns the final run object. */
export async function waitForRunCompletion({ owner, repo, runId }, { pollMs = 20 * 1000, timeoutMs = 55 * 60 * 1000 } = {}) {
  const { token } = await installationToken();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = await ghFetch("GET", `/repos/${owner}/${repo}/actions/runs/${runId}`, token);
    if (!r.ok) throw new Error(`GET run ${runId} failed: ${r.status} ${r.text?.slice(0, 300) || ""}`);
    if (r.json.status === "completed") return r.json;
    if (Date.now() >= deadline) throw new Error(`run ${runId} did not complete within ${timeoutMs}ms (last status ${r.json.status})`);
    await sleep(pollMs);
  }
}

export async function listRunArtifacts({ owner, repo, runId }) {
  const { token } = await installationToken();
  const out = [];
  let page = 1;
  for (;;) {
    const r = await ghFetch("GET", `/repos/${owner}/${repo}/actions/runs/${runId}/artifacts?per_page=100&page=${page}`, token);
    if (!r.ok) throw new Error(`GET run ${runId} artifacts failed: ${r.status} ${r.text?.slice(0, 300) || ""}`);
    out.push(...(r.json.artifacts || []));
    if (!r.json.artifacts || r.json.artifacts.length < 100) break;
    page++;
  }
  return out;
}

/** Downloads a GitHub Actions artifact zip to `outPath`. Follows the 302 from
 *  /actions/artifacts/{id}/zip WITHOUT the bearer (the redirected URL is a pre-signed,
 *  unauthenticated blob-storage link; re-sending the GitHub token to it is rejected). */
export async function downloadArtifactZip({ owner, repo, artifactId, outPath }) {
  const { token } = await installationToken();
  const r = await fetch(`${API}/repos/${owner}/${repo}/actions/artifacts/${artifactId}/zip`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
    redirect: "manual",
  });
  if (r.status !== 302) {
    const text = await r.text().catch(() => "");
    throw new Error(`artifact ${artifactId} download did not redirect (status ${r.status}): ${text.slice(0, 300)}`);
  }
  const location = r.headers.get("location");
  if (!location) throw new Error(`artifact ${artifactId} download 302 had no Location header`);
  const blob = await fetch(location);
  if (!blob.ok || !blob.body) throw new Error(`artifact ${artifactId} blob fetch failed: ${blob.status}`);
  await pipeline(Readable.fromWeb(blob.body), createWriteStream(outPath));
}
