'use strict';

const core = require('@actions/core');
const github = require('@actions/github');
const fs = require('fs');
const { submitCandidate, fetchStatus } = require('./api');
const {
  postPRComment,
  createCheckRun,
  updateCheckRun,
  buildCommentBody,
  buildCheckOutput,
} = require('./github');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function cleanUndefined(obj) {
  if (typeof obj !== 'object' || obj === null) return obj;
  if (Array.isArray(obj)) return obj.map(cleanUndefined);
  return Object.fromEntries(
    Object.entries(obj)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => [k, cleanUndefined(v)])
  );
}

async function run() {
  const apiUrl = core.getInput('brotni-api-url') || process.env.BROTNI_API_URL || '';
  const apiToken = core.getInput('brotni-token') || process.env.BROTNI_TOKEN || '';

  if (!apiUrl) throw new Error('brotni-api-url input or BROTNI_API_URL env var is required');
  if (!apiToken) throw new Error('brotni-token input or BROTNI_TOKEN env var is required');

  core.setSecret(apiToken);

  const simulationSpec = core.getInput('simulation-spec');
  const executionRecipe = core.getInput('execution-recipe');
  const contextSpec = core.getInput('context-spec');
  const artifactUri = core.getInput('artifact-uri');
  const artifactDigest = core.getInput('artifact-digest');
  const candidateName = core.getInput('candidate-name');
  const campaignId = core.getInput('campaign-id');
  const shouldWait = core.getBooleanInput('wait');
  const waitTimeout = parseInt(core.getInput('wait-timeout') || '600', 10);
  const waitInterval = parseInt(core.getInput('wait-interval') || '30', 10);
  const publishComment = core.getBooleanInput('publish-comment');
  const publishCheck = core.getBooleanInput('publish-check');
  const githubToken = core.getInput('github-token') || process.env.GITHUB_TOKEN || '';

  if (githubToken) core.setSecret(githubToken);

  const ctx = github.context;
  const { owner, repo } = ctx.repo;
  const sha = ctx.sha;
  const ref = ctx.ref;
  const refName = process.env.GITHUB_REF_NAME || '';
  const runId = String(ctx.runId);
  const actor = ctx.actor;
  const serverUrl = process.env.GITHUB_SERVER_URL || 'https://github.com';

  let eventPayload = ctx.payload;
  if (!eventPayload && process.env.GITHUB_EVENT_PATH) {
    try { eventPayload = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')); } catch {}
  }

  const pr = eventPayload && eventPayload.pull_request;
  const prNumber = pr ? pr.number : null;

  const payload = cleanUndefined({
    candidate_name: candidateName || `${ctx.eventName}/${sha.slice(0, 7)}`,
    campaign_id: campaignId || undefined,
    simulation_spec: simulationSpec || undefined,
    execution_recipe: executionRecipe || undefined,
    context_spec: contextSpec || undefined,
    artifact: (artifactUri || artifactDigest)
      ? { uri: artifactUri || undefined, digest: artifactDigest || undefined }
      : undefined,
    github: {
      repository: `${owner}/${repo}`,
      owner,
      repo,
      sha,
      ref,
      ref_name: refName,
      event_name: ctx.eventName,
      run_id: runId,
      actor,
      server_url: serverUrl,
      pull_request: pr
        ? {
            number: pr.number,
            title: pr.title,
            head_sha: pr.head.sha,
            head_ref: pr.head.ref,
            base_ref: pr.base.ref,
            url: pr.html_url,
          }
        : undefined,
    },
  });

  core.info(`Submitting simulation candidate to ${apiUrl}`);
  const submission = await submitCandidate(apiUrl, apiToken, payload);

  const candidateId = submission.candidate_id || submission.candidateId || '';
  const simRunId = submission.simulation_run_id || submission.simulationRunId || '';
  let effectiveReportUrl = submission.simulation_report_url || submission.reportUrl || '';

  core.setOutput('candidate-id', candidateId);
  core.setOutput('simulation-run-id', simRunId);
  core.setOutput('simulation-report-url', effectiveReportUrl);

  core.info(`Candidate submitted: ${candidateId}`);
  if (effectiveReportUrl) core.info(`Report URL: ${effectiveReportUrl}`);

  const octokit = githubToken ? github.getOctokit(githubToken) : null;
  let checkRunId = null;

  if (publishCheck && octokit) {
    try {
      const headSha = pr ? pr.head.sha : sha;
      const check = await createCheckRun(octokit, owner, repo, {
        name: 'Brotni Simulation',
        head_sha: headSha,
        status: 'in_progress',
        started_at: new Date().toISOString(),
        ...(effectiveReportUrl && { details_url: effectiveReportUrl }),
        output: {
          title: 'Brotni Simulation',
          summary: `Simulation candidate submitted. ID: \`${candidateId}\``,
        },
      });
      checkRunId = check.data.id;
    } catch (e) {
      core.warning(`Failed to create check run: ${e.message}`);
    }
  }

  let finalStatus = submission.status || 'pending';
  let finalScore = '';

  if (shouldWait && candidateId) {
    core.info(`Waiting for simulation (timeout: ${waitTimeout}s, interval: ${waitInterval}s)...`);
    const deadline = Date.now() + waitTimeout * 1000;
    let done = false;

    while (!done && Date.now() < deadline) {
      await sleep(waitInterval * 1000);
      try {
        const status = await fetchStatus(apiUrl, apiToken, candidateId);
        finalStatus = status.status || 'unknown';
        finalScore = status.score !== undefined ? String(status.score) : '';

        const updatedUrl = status.simulation_report_url || status.reportUrl || '';
        if (updatedUrl && updatedUrl !== effectiveReportUrl) {
          effectiveReportUrl = updatedUrl;
          core.setOutput('simulation-report-url', effectiveReportUrl);
        }

        core.info(`Status: ${finalStatus}${finalScore ? ` (score: ${finalScore})` : ''}`);

        if (!['pending', 'running', 'queued'].includes(finalStatus)) {
          done = true;
        }
      } catch (e) {
        core.warning(`Failed to fetch simulation status: ${e.message}`);
      }
    }

    if (!done) {
      finalStatus = 'timeout';
      core.warning(`Simulation did not complete within ${waitTimeout} seconds.`);
    }
  }

  core.setOutput('simulation-status', finalStatus);
  core.setOutput('simulation-score', finalScore);

  if (publishComment && octokit && prNumber) {
    try {
      const body = buildCommentBody(candidateId, simRunId, finalStatus, finalScore, effectiveReportUrl);
      await postPRComment(octokit, owner, repo, prNumber, body);
      core.info('PR comment posted.');
    } catch (e) {
      core.warning(`Failed to post PR comment: ${e.message}`);
    }
  }

  if (publishCheck && octokit && checkRunId) {
    try {
      const conclusion = { passed: 'success', failed: 'failure', timeout: 'timed_out' }[finalStatus];
      await updateCheckRun(octokit, owner, repo, checkRunId, {
        status: conclusion ? 'completed' : 'in_progress',
        ...(conclusion && { conclusion, completed_at: new Date().toISOString() }),
        ...(effectiveReportUrl && { details_url: effectiveReportUrl }),
        output: buildCheckOutput(candidateId, simRunId, finalStatus, finalScore),
      });
      core.info('Check run updated.');
    } catch (e) {
      core.warning(`Failed to update check run: ${e.message}`);
    }
  }

  const summaryRows = [
    ['Candidate ID', `\`${candidateId}\``],
    simRunId ? ['Run ID', `\`${simRunId}\``] : null,
    ['Status', finalStatus],
    finalScore ? ['Score', finalScore] : null,
    effectiveReportUrl ? ['Report', `[View](${effectiveReportUrl})`] : null,
  ].filter(Boolean);

  const summaryTable = [
    '## Brotni Simulation',
    '',
    '| | |',
    '|---|---|',
    ...summaryRows.map(([k, v]) => `| **${k}** | ${v} |`),
  ].join('\n');

  core.summary.addRaw(summaryTable).write();
}

run().catch((err) => core.setFailed(err.message));
