"use strict";

// Approvals from GitHub, for SOC 2 change management (CC8.1): an auditor
// asks not only who made a change but who approved it. Git cannot say; the
// pull request that merged the commit can, and GitHub authenticates those
// identities, unlike a commit's author line.
//
// Needs a token that can read pull requests (the workflow's GITHUB_TOKEN with
// `pull-requests: read`). Without one, or on any error, it returns nothing
// for that commit and tracking carries on: a missing approval is shown as
// missing, never invented.

const API = "https://api.github.com";

async function getJson(fetchImpl, url, token) {
  const res = await fetchImpl(url, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: "Bearer " + token,
      "x-github-api-version": "2022-11-28",
      "user-agent": "germline",
    },
  });
  if (!res.ok) throw new Error("GitHub API " + res.status + " for " + url);
  return res.json();
}

/// { [sha]: { pr, url, approvedBy: [login], approvedAt, mergedBy, mergedAt } }
async function approvalsFor(shas, options = {}) {
  const repo = options.repo || process.env.GITHUB_REPOSITORY;
  const token = "token" in options ? options.token : process.env.GITHUB_TOKEN;
  const fetchImpl = options.fetch || globalThis.fetch;
  const out = {};
  if (!repo || !token || !fetchImpl || !/^[\w.-]+\/[\w.-]+$/.test(repo)) return out;
  for (const sha of shas) {
    if (!/^[0-9a-f]{40}$/.test(sha)) continue;
    try {
      const pulls = await getJson(fetchImpl, API + "/repos/" + repo + "/commits/" + sha + "/pulls", token);
      const pr = (Array.isArray(pulls) ? pulls : []).find((p) => p.merged_at) || null;
      if (!pr) continue;
      // The list endpoint omits merged_by; the pull request itself has it.
      const detail = await getJson(fetchImpl, API + "/repos/" + repo + "/pulls/" + pr.number, token);
      const reviews = await getJson(fetchImpl, API + "/repos/" + repo + "/pulls/" + pr.number + "/reviews?per_page=100", token);
      // A reviewer's latest review is what counts: approve-then-request-changes is not an approval.
      const latest = new Map();
      for (const r of Array.isArray(reviews) ? reviews : []) {
        if (r && r.user && r.user.login && r.state !== "COMMENTED") latest.set(r.user.login, r);
      }
      const approved = Array.from(latest.values()).filter((r) => r.state === "APPROVED");
      out[sha] = {
        source: "github",
        pr: pr.number,
        url: pr.html_url || null,
        approvedBy: approved.map((r) => r.user.login).sort(),
        approvedAt: approved.map((r) => r.submitted_at).sort().pop() || null,
        mergedBy: (detail && detail.merged_by && detail.merged_by.login) || null,
        mergedAt: pr.merged_at,
      };
    } catch (error) {
      if (options.onError) options.onError(sha, error);
    }
  }
  return out;
}

module.exports = { approvalsFor };
