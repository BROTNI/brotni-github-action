'use strict';

const core = require('@actions/core');
const github = require('@actions/github');
const fs = require('fs');
const { registerCandidate, fetchDecision } = require('./api');
const {
  postPRComment,
  createCheckRun,
  buildCommentBody,
  buildCheckOutput,
} = require('./github');

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

  // The action registers the build as a candidate in an existing campaign.
  // There is no non-campaign candidate in the model, so campaign-id is required.
  const campaignId = core.getInput('campaign-id');
  if (!campaignId) {
    throw new Error(
      'campaign-id is required: this action registers the build as a candidate in an existing Brotni campaign. ' +
        'Create the campaign first (e.g. `brotni campaign create`).'
    );
  }

  const executionRecipe = core.getInput('execution-recipe');
  const artifactUri = core.getInput('artifact-uri');
  const artifactDigest = core.getInput('artifact-digest');
  const candidateName = core.getInput('candidate-name');
  const candidateLabel = core.getInput('candidate-label') || 'brotni-simulation-candidate';
  const sourceKind = core.getInput('source-kind');
  const publishComment = core.getBooleanInput('publish-comment');
  const publishCheck = core.getBooleanInput('publish-check');
  const githubToken = core.getInput('github-token') || process.env.GITHUB_TOKEN || '';
  if (githubToken) core.setSecret(githubToken);

  const ctx = github.context;
  const { owner, repo } = ctx.repo;
  const sha = ctx.sha;
  const refName = process.env.GITHUB_REF_NAME || '';

  let eventPayload = ctx.payload;
  if (!eventPayload && process.env.GITHUB_EVENT_PATH) {
    try { eventPayload = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')); } catch {}
  }
  const pr = eventPayload && eventPayload.pull_request;
  const prNumber = pr ? pr.number : null;

  const prLabels = pr && Array.isArray(pr.labels) ? pr.labels.map((l) => l.name) : [];
  const discoveredVia = prLabels.includes(candidateLabel) ? 'label' : 'cli';
  const resolvedSourceKind = sourceKind || (artifactUri || artifactDigest ? 'container_image' : 'git_change');

  // Stable candidate name so re-runs on later pushes upsert rather than
  // duplicate. Prefer the PR number; fall back to a branch/sha name.
  const name = candidateName || (prNumber ? `pr-${prNumber}` : `${refName || ctx.eventName}-${sha.slice(0, 7)}`);

  // Note: the work item is a campaign-level property (set at campaign creation),
  // not a candidate field, so it is intentionally not part of this payload.
  const candidatePayload = cleanUndefined({
    name,
    sourceKind: resolvedSourceKind,
    recipeRef: executionRecipe || undefined,
    discoveredVia,
    sourceRef: {
      provider: 'github',
      repository: `${owner}/${repo}`,
      changeRequestType: pr ? 'pull_request' : 'commit',
      changeRequestId: prNumber ? String(prNumber) : undefined,
      branch: pr ? pr.head.ref : refName || undefined,
      headSha: pr ? pr.head.sha : sha,
      baseSha: pr ? pr.base.sha : undefined,
      url: pr ? pr.html_url : undefined,
    },
    artifactRef: (artifactUri || artifactDigest)
      ? { kind: 'oci-image', uri: artifactUri || undefined, digest: artifactDigest || undefined }
      : undefined,
  });

  core.info(`Registering candidate "${name}" with campaign ${campaignId}`);
  const submission = await registerCandidate(apiUrl, apiToken, campaignId, candidatePayload);
  const candidateId = submission.id || submission.candidate_id || submission.candidateId || '';
  core.setOutput('candidate-id', candidateId);
  core.info(`Candidate registered: ${candidateId}`);

  // Best-effort: read the campaign decision to surface this candidate's rank and
  // score. It is empty until the studio has run the candidates and ingested
  // metrics, so the action does not block waiting for it.
  let status = 'registered';
  let score = '';
  let rank = null;
  let total = null;
  let campaignUrl = submission.campaign_url || submission.campaignUrl || '';
  try {
    const decision = await fetchDecision(apiUrl, apiToken, campaignId);
    const ranking = Array.isArray(decision.ranking) ? decision.ranking : [];
    total = ranking.length || null;
    const mine = ranking.find((r) => r.candidateId === candidateId);
    if (mine) {
      rank = mine.rank;
      score = mine.overallScore !== undefined ? String(mine.overallScore) : '';
      status = mine.passedBlocking ? 'passed' : 'failed';
    }
  } catch (e) {
    core.info(`Campaign decision not available yet: ${e.message}`);
  }

  core.setOutput('simulation-status', status);
  core.setOutput('simulation-score', score);
  core.setOutput('campaign-url', campaignUrl);

  const campaign = { id: campaignId, url: campaignUrl, rank, total };
  const octokit = githubToken ? github.getOctokit(githubToken) : null;

  if (publishCheck && octokit) {
    try {
      const headSha = pr ? pr.head.sha : sha;
      const conclusion = { passed: 'success', failed: 'failure' }[status] || 'neutral';
      await createCheckRun(octokit, owner, repo, {
        name: 'Brotni Simulation Campaign',
        head_sha: headSha,
        status: 'completed',
        conclusion,
        completed_at: new Date().toISOString(),
        ...(campaignUrl && { details_url: campaignUrl }),
        output: buildCheckOutput(candidateId, '', status, score, campaign),
      });
      core.info('Check run published.');
    } catch (e) {
      core.warning(`Failed to create check run: ${e.message}`);
    }
  }

  if (publishComment && octokit && prNumber) {
    try {
      const body = buildCommentBody(candidateId, '', status, score, '', campaign);
      await postPRComment(octokit, owner, repo, prNumber, body);
      core.info('PR comment posted.');
    } catch (e) {
      core.warning(`Failed to post PR comment: ${e.message}`);
    }
  }

  const summaryRows = [
    ['Campaign', `\`${campaignId}\``],
    ['Candidate', `\`${candidateId}\` (${name})`],
    rank && total ? ['Rank', `${rank} of ${total}`] : null,
    ['Status', status],
    score ? ['Score', score] : null,
    campaignUrl ? ['Compare', `[View](${campaignUrl})`] : null,
  ].filter(Boolean);

  const summaryTable = [
    '## Brotni Simulation Campaign',
    '',
    '| | |',
    '|---|---|',
    ...summaryRows.map(([k, v]) => `| **${k}** | ${v} |`),
  ].join('\n');

  core.summary.addRaw(summaryTable).write();
}

run().catch((err) => core.setFailed(err.message));
