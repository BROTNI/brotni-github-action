'use strict';

async function postPRComment(octokit, owner, repo, prNumber, body) {
  return octokit.rest.issues.createComment({ owner, repo, issue_number: prNumber, body });
}

async function createCheckRun(octokit, owner, repo, data) {
  return octokit.rest.checks.create({ owner, repo, ...data });
}

async function updateCheckRun(octokit, owner, repo, checkRunId, data) {
  return octokit.rest.checks.update({ owner, repo, check_run_id: checkRunId, ...data });
}

// rankLine renders a "Candidate N of M" badge when campaign ranking is known.
function rankLine(campaign) {
  if (!campaign) return null;
  if (campaign.rank && campaign.total) {
    return `- **Campaign candidate:** ${campaign.rank} of ${campaign.total}`;
  }
  if (campaign.total) {
    return `- **Campaign candidates:** ${campaign.total}`;
  }
  return null;
}

function buildCommentBody(candidateId, simRunId, finalStatus, finalScore, reportUrl, campaign) {
  const emoji = { passed: '✅', failed: '❌', timeout: '⏱️' }[finalStatus] || '🔵';
  const heading = campaign && campaign.id ? 'Brotni Simulation Campaign' : 'Brotni Simulation';
  const lines = [
    `## ${emoji} ${heading}`,
    '',
    campaign && campaign.id ? `- **Campaign:** \`${campaign.id}\`` : null,
    `- **Candidate ID:** \`${candidateId}\``,
    simRunId ? `- **Run ID:** \`${simRunId}\`` : null,
    rankLine(campaign),
    `- **Status:** ${finalStatus}`,
    finalScore ? `- **Score:** ${finalScore}` : null,
    '',
    reportUrl ? `[View simulation report](${reportUrl})` : null,
    campaign && campaign.url ? `[Compare candidates in this campaign](${campaign.url})` : null,
    '',
    '_This action does not run simulations itself. It submits candidates to a Brotni-compatible simulation workflow and publishes the resulting status back to GitHub._',
  ];
  return lines.filter((l) => l !== null).join('\n');
}

function buildCheckOutput(candidateId, simRunId, finalStatus, finalScore, campaign) {
  const summary = [
    campaign && campaign.id ? `**Campaign:** \`${campaign.id}\`` : null,
    `**Candidate ID:** \`${candidateId}\``,
    simRunId ? `**Run ID:** \`${simRunId}\`` : null,
    rankLine(campaign) ? rankLine(campaign).replace(/^- /, '') : null,
    `**Status:** ${finalStatus}`,
    finalScore ? `**Score:** ${finalScore}` : null,
    campaign && campaign.url ? `[Compare candidates](${campaign.url})` : null,
  ].filter(Boolean).join('\n');
  const title = campaign && campaign.id
    ? `Brotni Simulation Campaign — ${finalStatus}`
    : `Brotni Simulation — ${finalStatus}`;
  return { title, summary };
}

module.exports = {
  postPRComment,
  createCheckRun,
  updateCheckRun,
  buildCommentBody,
  buildCheckOutput,
};
