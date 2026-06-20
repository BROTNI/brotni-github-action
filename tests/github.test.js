'use strict';

const {
  postPRComment,
  createCheckRun,
  updateCheckRun,
  buildCommentBody,
  buildCheckOutput,
} = require('../src/github');

describe('buildCommentBody', () => {
  test('renders a passed result with all fields', () => {
    const body = buildCommentBody('cand-1', 'run-1', 'passed', '0.92', 'https://example.com/report');
    expect(body).toContain('✅ Brotni Simulation');
    expect(body).toContain('**Candidate ID:** `cand-1`');
    expect(body).toContain('**Run ID:** `run-1`');
    expect(body).toContain('**Status:** passed');
    expect(body).toContain('**Score:** 0.92');
    expect(body).toContain('[View simulation report](https://example.com/report)');
  });

  test('omits optional fields when absent', () => {
    const body = buildCommentBody('cand-2', '', 'pending', '', '');
    expect(body).toContain('🔵 Brotni Simulation');
    expect(body).not.toContain('Run ID');
    expect(body).not.toContain('Score');
    expect(body).not.toContain('View simulation report');
  });

  test('uses the failure emoji for a failed status', () => {
    expect(buildCommentBody('c', '', 'failed', '', '')).toContain('❌');
  });

  test('renders campaign context with rank and comparison link', () => {
    const body = buildCommentBody('cand-1', '', 'passed', '0.9', 'https://example.com/report', {
      id: 'camp-1',
      url: 'https://example.com/campaign',
      rank: 2,
      total: 4,
    });
    expect(body).toContain('Brotni Simulation Campaign');
    expect(body).toContain('**Campaign:** `camp-1`');
    expect(body).toContain('**Campaign candidate:** 2 of 4');
    expect(body).toContain('[Compare candidates in this campaign](https://example.com/campaign)');
  });
});

describe('buildCheckOutput', () => {
  test('includes status in the title and summary', () => {
    const out = buildCheckOutput('cand-1', 'run-1', 'passed', '0.92');
    expect(out.title).toBe('Brotni Simulation — passed');
    expect(out.summary).toContain('**Candidate ID:** `cand-1`');
    expect(out.summary).toContain('**Run ID:** `run-1`');
    expect(out.summary).toContain('**Score:** 0.92');
  });

  test('drops empty optional rows', () => {
    const out = buildCheckOutput('cand-2', '', 'pending', '');
    expect(out.summary).not.toContain('Run ID');
    expect(out.summary).not.toContain('Score');
  });

  test('includes campaign context in the title and summary', () => {
    const out = buildCheckOutput('cand-1', '', 'passed', '0.9', {
      id: 'camp-1',
      url: 'https://example.com/campaign',
      rank: 1,
      total: 3,
    });
    expect(out.title).toBe('Brotni Simulation Campaign — passed');
    expect(out.summary).toContain('**Campaign:** `camp-1`');
    expect(out.summary).toContain('**Campaign candidate:** 1 of 3');
    expect(out.summary).toContain('[Compare candidates](https://example.com/campaign)');
  });
});

describe('octokit wrappers', () => {
  test('postPRComment calls issues.createComment with the right shape', async () => {
    const createComment = jest.fn().mockResolvedValue({ data: { id: 1 } });
    const octokit = { rest: { issues: { createComment } } };
    await postPRComment(octokit, 'o', 'r', 7, 'hello');
    expect(createComment).toHaveBeenCalledWith({
      owner: 'o',
      repo: 'r',
      issue_number: 7,
      body: 'hello',
    });
  });

  test('createCheckRun forwards data to checks.create', async () => {
    const create = jest.fn().mockResolvedValue({ data: { id: 9 } });
    const octokit = { rest: { checks: { create } } };
    await createCheckRun(octokit, 'o', 'r', { name: 'X', head_sha: 'abc' });
    expect(create).toHaveBeenCalledWith({ owner: 'o', repo: 'r', name: 'X', head_sha: 'abc' });
  });

  test('updateCheckRun forwards data to checks.update', async () => {
    const update = jest.fn().mockResolvedValue({ data: { id: 9 } });
    const octokit = { rest: { checks: { update } } };
    await updateCheckRun(octokit, 'o', 'r', 9, { status: 'completed' });
    expect(update).toHaveBeenCalledWith({
      owner: 'o',
      repo: 'r',
      check_run_id: 9,
      status: 'completed',
    });
  });
});
