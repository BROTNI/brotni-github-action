'use strict';

const https = require('https');
const http = require('http');
const { URL } = require('url');

function request(urlStr, method, token, body = null) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const lib = u.protocol === 'https:' ? https : http;
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': 'brotni-github-action/1.0',
    };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const opts = {
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method,
      headers,
    };

    const handleResponse = (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(data); } catch { parsed = data; }
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(parsed);
        } else {
          const msg = typeof parsed === 'object' ? JSON.stringify(parsed) : parsed;
          reject(new Error(`HTTP ${res.statusCode}: ${msg}`));
        }
      });
      res.on('error', reject);
    };

    if (body) {
      const bodyStr = JSON.stringify(body);
      opts.headers['Content-Length'] = Buffer.byteLength(bodyStr);
      const req = lib.request(opts, handleResponse);
      req.setTimeout(30000, () => req.destroy(new Error('Request timed out')));
      req.on('error', reject);
      req.write(bodyStr);
      req.end();
    } else {
      const req = lib.request(opts, handleResponse);
      req.setTimeout(30000, () => req.destroy(new Error('Request timed out')));
      req.on('error', reject);
      req.end();
    }
  });
}

function base(apiUrl) {
  return apiUrl.replace(/\/$/, '');
}

// registerCandidate registers the build as a candidate in an existing campaign.
// The simulation-engine owns the campaign domain; the studio-api BFF exposes it
// under /api/v1/campaigns. Registration is idempotent by candidate name.
async function registerCandidate(apiUrl, token, campaignId, payload) {
  return request(
    `${base(apiUrl)}/api/v1/campaigns/${encodeURIComponent(campaignId)}/candidates`,
    'POST',
    token,
    payload
  );
}

// fetchDecision reads the campaign decision report (best-effort) to surface this
// candidate's rank and score. It is empty until run metrics have been ingested.
async function fetchDecision(apiUrl, token, campaignId) {
  return request(
    `${base(apiUrl)}/api/v1/campaigns/${encodeURIComponent(campaignId)}/decision`,
    'GET',
    token
  );
}

module.exports = { registerCandidate, fetchDecision };
