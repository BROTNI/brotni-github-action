'use strict';

/**
 * Self-contained production bundle for brotni-github-action.
 * Built from src/ — no external npm dependencies required at runtime.
 * Uses only Node.js built-in modules: https, http, fs, url.
 *
 * To rebuild from source:
 *   npm install && npm run build
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const { URL } = require('url');

// ─── Inline @actions/core helpers ────────────────────────────────────────────

function getInput(name, opts = {}) {
  const key = `INPUT_${name.replace(/ /g, '_').toUpperCase()}`;
  const val = (process.env[key] || '').trim();
  if (opts.required && !val) throw new Error(`Input required and not supplied: ${name}`);
  return val;
}

function getBooleanInput(name, defaultVal = false) {
  const raw = getInput(name);
  if (!raw) return defaultVal;
  const v = raw.toLowerCase();
  if (v === 'true' || v === 'yes' || v === '1') return true;
  if (v === 'false' || v === 'no' || v === '0') return false;
  throw new Error(`Input "${name}" must be a boolean value (true/false), got: ${raw}`);
}

function getIntInput(name, defaultVal) {
  const raw = getInput(name);
  if (!raw) return defaultVal;
  const n = parseInt(raw, 10);
  if (isNaN(n)) throw new Error(`Input "${name}" must be an integer, got: ${raw}`);
  return n;
}

function setOutput(name, value) {
  const f = process.env.GITHUB_OUTPUT;
  if (f) {
    fs.appendFileSync(f, `${name}=${value}\n`);
  } else {
    process.stdout.write(`::set-output name=${name}::${value}\n`);
  }
}

function info(msg) { process.stdout.write(msg + '\n'); }
function warning(msg) { process.stdout.write(`::warning::${msg}\n`); }

function setFailed(msg) {
  process.stdout.write(`::error::${msg}\n`);
  process.exitCode = 1;
}

function maskSecret(secret) {
  if (secret) process.stdout.write(`::add-mask::${secret}\n`);
}

function appendSummary(text) {
  const f = process.env.GITHUB_STEP_SUMMARY;
  if (f) {
    try { fs.appendFileSync(f, text + '\n'); } catch {}
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── HTTP helper ─────────────────────────────────────────────────────────────

function httpRequest(urlStr, method, extraHeaders = {}, body = null) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const lib = u.protocol === 'https:' ? https : http;
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': 'brotni-github-action/1.0',
      ...extraHeaders,
    };

    const opts = {
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method,
      headers,
    };

    const onResponse = (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(data); } catch { parsed = data; }
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(parsed);
        } else {
          const detail = typeof parsed === 'object' ? JSON.stringify(parsed) : parsed;
          reject(new Error(`HTTP ${res.statusCode}: ${detail}`));
        }
      });
      res.on('error', reject);
    };

    if (body) {
      const bodyStr = JSON.stringify(body);
      opts.headers['Content-Length'] = Buffer.byteLength(bodyStr);
      const req = lib.request(opts, onResponse);
      req.setTimeout(30000, () => req.destroy(new Error('Request timed out after 30s')));
      req.on('error', reject);
      req.write(bodyStr);
      req.end();
    } else {
      const req = lib.request(opts, onResponse);
      req.setTimeout(30000, () => req.destroy(new Error('Request timed out after 30s')));
      req.on('error', reject);
      req.end();
    }
  });
}

// ─── Brotni API ───────────────────────────────────────────────────────────────

function brotniHeaders(token) {
  return { Authorization: `Bearer ${token}` };
}

async function submitCandidate(apiUrl, token, payload) {
  const url = `${apiUrl.replace(/\/$/, '')}/api/v1/candidates`;
  return httpRequest(url, 'POST', brotniHeaders(token), payload);
}

async function fetchStatus(apiUrl, token, candidateId) {
  const url = `${apiUrl.replace(/\/$/, '')}/api/v1/candidates/${candidateId}/status`;
  return httpRequest(url, 'GET', brotniHeaders(token));
}

// ─── GitHub API ───────────────────────────────────────────────────────────────

const GH_API = process.env.GITHUB_API_URL || 'https://api.github.com';

function ghHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

async function ghPost(token, path, body) {
  return httpRequest(`${GH_API}${path}`, 'POST', ghHeaders(token), body);
}

async function ghPatch(token, path, body) {
  return httpRequest(`${GH_API}${path}`, 'PATCH', ghHeaders(token), body);
}

async function postPRComment(token, owner, repo, prNumber, body) {
  return ghPost(token, `/repos/${owner}/${repo}/issues/${prNumber}/comments`, { body });
}

async function createCheckRun(token, owner, repo, data) {
  return ghPost(token, `/repos/${owner}/${repo}/check-runs`, data);
}

async function updateCheckRun(token, owner, repo, checkRunId, data) {
  return ghPatch(token, `/repos/${owner}/${repo}/check-runs/${checkRunId}`, data);
}

// ─── Payload helpers ─────────────────────────────────────────────────────────

function cleanUndefined(obj) {
  if (typeof obj !== 'object' || obj === null) return obj;
  if (Array.isArray(obj)) return obj.map(cleanUndefined);
  return Object.fromEntries(
    Object.entries(obj)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => [k, cleanUndefined(v)])
  );
}

function buildCommentBody(candidateId, simRunId, finalStatus, finalScore, reportUrl) {
  const emoji = { passed: '✅', failed: '❌', timeout: '⏱️' }[finalStatus] || '🔵';
  const lines = [
    `## ${emoji} Brotni Simulation`,
    '',
    `- **Candidate ID:** \`${candidateId}\``,
    simRunId ? `- **Run ID:** \`${simRunId}\`` : null,
    `- **Status:** ${finalStatus}`,
    finalScore ? `- **Score:** ${finalScore}` : null,
    reportUrl ? '' : null,
    reportUrl ? `[View simulation report](${reportUrl})` : null,
    '',
    '_This action does not run simulations itself. It submits candidates to a Brotni-compatible simulation workflow and publishes the resulting status back to GitHub._',
  ];
  return lines.filter((l) => l !== null).join('\n');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function run() {
  // Inputs — with env var fallback for api url and token
  const apiUrl = getInput('brotni-api-url') || process.env.BROTNI_API_URL || '';
  const apiToken = getInput('brotni-token') || process.env.BROTNI_TOKEN || '';

  if (!apiUrl) throw new Error('brotni-api-url input or BROTNI_API_URL environment variable is required');
  if (!apiToken) throw new Error('brotni-token input or BROTNI_TOKEN environment variable is required');

  maskSecret(apiToken);

  const simulationSpec  = getInput('simulation-spec');
  const executionRecipe = getInput('execution-recipe');
  const contextSpec     = getInput('context-spec');
  const artifactUri     = getInput('artifact-uri');
  const artifactDigest  = getInput('artifact-digest');
  const candidateName   = getInput('candidate-name');
  const campaignId      = getInput('campaign-id');
  const shouldWait      = getBooleanInput('wait', false);
  const waitTimeout     = getIntInput('wait-timeout', 600);
  const waitInterval    = getIntInput('wait-interval', 30);
  const publishComment  = getBooleanInput('publish-comment', false);
  const publishCheck    = getBooleanInput('publish-check', false);
  const githubToken     = getInput('github-token') || process.env.GITHUB_TOKEN || '';

  if (githubToken) maskSecret(githubToken);

  // GitHub context from runner environment
  const repository = process.env.GITHUB_REPOSITORY || '';
  const [owner, repo] = repository.split('/');
  const sha         = process.env.GITHUB_SHA || '';
  const ref         = process.env.GITHUB_REF || '';
  const refName     = process.env.GITHUB_REF_NAME || '';
  const eventName   = process.env.GITHUB_EVENT_NAME || '';
  const runId       = process.env.GITHUB_RUN_ID || '';
  const actor       = process.env.GITHUB_ACTOR || '';
  const serverUrl   = process.env.GITHUB_SERVER_URL || 'https://github.com';

  // Event payload (contains PR metadata on pull_request events)
  let eventPayload = {};
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (eventPath) {
    try { eventPayload = JSON.parse(fs.readFileSync(eventPath, 'utf8')); } catch {}
  }

  const pr = eventPayload.pull_request;
  const prNumber = pr ? pr.number : null;

  const candidatePayload = cleanUndefined({
    candidate_name: candidateName || `${eventName}/${sha.slice(0, 7)}`,
    campaign_id:    campaignId    || undefined,
    simulation_spec:   simulationSpec   || undefined,
    execution_recipe:  executionRecipe  || undefined,
    context_spec:      contextSpec      || undefined,
    artifact: (artifactUri || artifactDigest)
      ? { uri: artifactUri || undefined, digest: artifactDigest || undefined }
      : undefined,
    github: {
      repository,
      owner,
      repo,
      sha,
      ref,
      ref_name:   refName,
      event_name: eventName,
      run_id:     runId,
      actor,
      server_url: serverUrl,
      pull_request: pr ? {
        number:   pr.number,
        title:    pr.title,
        head_sha: pr.head.sha,
        head_ref: pr.head.ref,
        base_ref: pr.base.ref,
        url:      pr.html_url,
      } : undefined,
    },
  });

  info(`Submitting simulation candidate to ${apiUrl}`);
  const submission = await submitCandidate(apiUrl, apiToken, candidatePayload);

  const candidateId = submission.candidate_id || submission.candidateId || '';
  const simRunId    = submission.simulation_run_id || submission.simulationRunId || '';
  let effectiveReportUrl = submission.simulation_report_url || submission.reportUrl || '';

  setOutput('candidate-id', candidateId);
  setOutput('simulation-run-id', simRunId);
  setOutput('simulation-report-url', effectiveReportUrl);

  info(`Candidate submitted: ${candidateId}`);
  if (effectiveReportUrl) info(`Report URL: ${effectiveReportUrl}`);

  // Create check run in "in_progress" state immediately
  let checkRunId = null;
  if (publishCheck && githubToken && owner && repo) {
    try {
      const headSha = (pr && pr.head && pr.head.sha) ? pr.head.sha : sha;
      const check = await createCheckRun(githubToken, owner, repo, cleanUndefined({
        name:        'Brotni Simulation',
        head_sha:    headSha,
        status:      'in_progress',
        started_at:  new Date().toISOString(),
        details_url: effectiveReportUrl || undefined,
        output: {
          title:   'Brotni Simulation',
          summary: `Simulation candidate submitted. ID: \`${candidateId}\``,
        },
      }));
      checkRunId = check.id;
    } catch (e) {
      warning(`Failed to create check run: ${e.message}`);
    }
  }

  let finalStatus = submission.status || 'pending';
  let finalScore  = '';

  // Poll for simulation completion
  if (shouldWait && candidateId) {
    info(`Waiting for simulation (timeout: ${waitTimeout}s, interval: ${waitInterval}s)...`);
    const deadline = Date.now() + waitTimeout * 1000;
    let done = false;

    while (!done && Date.now() < deadline) {
      await sleep(waitInterval * 1000);
      try {
        const status = await fetchStatus(apiUrl, apiToken, candidateId);
        finalStatus = status.status || 'unknown';
        finalScore  = status.score !== undefined ? String(status.score) : '';

        const updatedUrl = status.simulation_report_url || status.reportUrl || '';
        if (updatedUrl && updatedUrl !== effectiveReportUrl) {
          effectiveReportUrl = updatedUrl;
          setOutput('simulation-report-url', effectiveReportUrl);
        }

        info(`Status: ${finalStatus}${finalScore ? ` (score: ${finalScore})` : ''}`);

        if (!['pending', 'running', 'queued'].includes(finalStatus)) {
          done = true;
        }
      } catch (e) {
        warning(`Failed to fetch simulation status: ${e.message}`);
      }
    }

    if (!done) {
      finalStatus = 'timeout';
      warning(`Simulation did not complete within ${waitTimeout} seconds.`);
    }
  }

  setOutput('simulation-status', finalStatus);
  setOutput('simulation-score', finalScore);

  // Post PR comment
  if (publishComment && githubToken && owner && repo && prNumber) {
    try {
      const body = buildCommentBody(candidateId, simRunId, finalStatus, finalScore, effectiveReportUrl);
      await postPRComment(githubToken, owner, repo, prNumber, body);
      info('PR comment posted.');
    } catch (e) {
      warning(`Failed to post PR comment: ${e.message}`);
    }
  }

  // Update check run with final status
  if (publishCheck && githubToken && owner && repo && checkRunId) {
    try {
      const conclusion = { passed: 'success', failed: 'failure', timeout: 'timed_out' }[finalStatus];
      await updateCheckRun(githubToken, owner, repo, checkRunId, cleanUndefined({
        status:       conclusion ? 'completed' : 'in_progress',
        conclusion:   conclusion || undefined,
        completed_at: conclusion ? new Date().toISOString() : undefined,
        details_url:  effectiveReportUrl || undefined,
        output: {
          title: `Brotni Simulation — ${finalStatus}`,
          summary: [
            `**Candidate ID:** \`${candidateId}\``,
            simRunId    ? `**Run ID:** \`${simRunId}\``   : null,
            `**Status:** ${finalStatus}`,
            finalScore  ? `**Score:** ${finalScore}`       : null,
          ].filter(Boolean).join('\n'),
        },
      }));
      info('Check run updated.');
    } catch (e) {
      warning(`Failed to update check run: ${e.message}`);
    }
  }

  // Step summary
  const rows = [
    ['Candidate ID', `\`${candidateId}\``],
    simRunId          ? ['Run ID',  `\`${simRunId}\``]                 : null,
    ['Status',          finalStatus],
    finalScore        ? ['Score',   finalScore]                         : null,
    effectiveReportUrl ? ['Report', `[View](${effectiveReportUrl})`]   : null,
  ].filter(Boolean);

  appendSummary([
    '## Brotni Simulation',
    '',
    '| | |',
    '|---|---|',
    ...rows.map(([k, v]) => `| **${k}** | ${v} |`),
  ].join('\n'));
}

run().catch((err) => setFailed(err.message));
