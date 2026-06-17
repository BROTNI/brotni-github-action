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

function buildCheckOutput(candidateId, simRunId, finalStatus, finalScore) {
  const summary = [
    `**Candidate ID:** \`${candidateId}\``,
    simRunId ? `**Run ID:** \`${simRunId}\`` : null,
    `**Status:** ${finalStatus}`,
    finalScore ? `**Score:** ${finalScore}` : null,
  ].filter(Boolean).join('\n');
  return { title: `Brotni Simulation — ${finalStatus}`, summary };
}

module.exports = {
  postPRComment,
  createCheckRun,
  updateCheckRun,
  buildCommentBody,
  buildCheckOutput,
};
