# brotni-github-action

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![GitHub Marketplace](https://img.shields.io/badge/Marketplace-Brotni%20Simulation-blue?logo=github)](https://github.com/marketplace/actions/brotni-simulation)

**This action does not run simulations itself. It submits candidates to a Brotni-compatible simulation workflow and publishes the resulting status back to GitHub.**

Thin GitHub Action wrapper that collects GitHub metadata, submits pull requests, commits, and OCI artifacts as simulation candidates to a Brotni-compatible API, optionally waits for the result, and publishes a check run and/or PR comment with a link to the simulation report.

---

## Table of Contents

- [Quick start](#quick-start)
- [Inputs](#inputs)
- [Outputs](#outputs)
- [Examples](#examples)
  - [Minimal example](#minimal-example)
  - [PR candidate](#pr-candidate)
  - [OCI image candidate](#oci-image-candidate)
  - [Wait for result and gate](#wait-for-result-and-gate)
- [Permissions](#permissions)
- [Security considerations](#security-considerations)
- [Publishing status, checks, and comments](#publishing-status-checks-and-comments)
- [Using with brotni-cli](#using-with-brotni-cli)
- [Contributing](#contributing)
- [License](#license)

---

## Quick start

```yaml
- uses: BROTNI/brotni-github-action@v1
  with:
    brotni-api-url: ${{ vars.BROTNI_API_URL }}
    brotni-token: ${{ secrets.BROTNI_TOKEN }}
    simulation-spec: simulation.yml
```

---

## Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `brotni-api-url` | ✱ | — | Base URL of the Brotni-compatible simulation API. Falls back to `BROTNI_API_URL` env var. |
| `brotni-token` | ✱ | — | API authentication token. Falls back to `BROTNI_TOKEN` env var. |
| `simulation-spec` | | — | Path or URI of the simulation specification file. |
| `execution-recipe` | | — | Path or URI of the execution recipe. |
| `context-spec` | | — | Path or URI of the context specification. |
| `artifact-uri` | | — | OCI image reference or other artifact URI to submit as a candidate. |
| `artifact-digest` | | — | Content-addressable digest (e.g. `sha256:abc123...`) for immutable artifact pinning. |
| `candidate-name` | | auto | Human-readable name for this candidate. Defaults to `<event>/<sha7>`. |
| `campaign-id` | | — | Brotni campaign ID to associate this candidate with. |
| `wait` | | `false` | Wait for simulation completion before the step exits. |
| `wait-timeout` | | `600` | Maximum seconds to wait when `wait=true`. |
| `wait-interval` | | `30` | Polling interval in seconds when `wait=true`. |
| `publish-comment` | | `false` | Post a PR comment with the simulation result. Requires `pull-requests: write`. |
| `publish-check` | | `false` | Create a GitHub Check Run with the result. Requires `checks: write`. |
| `github-token` | | `github.token` | Token used for posting comments and check runs. |

✱ One of `brotni-api-url` / `BROTNI_API_URL` and one of `brotni-token` / `BROTNI_TOKEN` must be provided.

---

## Outputs

| Output | Description |
|---|---|
| `candidate-id` | Unique identifier of the submitted simulation candidate. |
| `simulation-run-id` | Identifier of the triggered simulation run. |
| `simulation-report-url` | URL to the simulation report. |
| `simulation-status` | Final status: `passed`, `failed`, `running`, `pending`, or `timeout`. Only meaningful when `wait=true`. |
| `simulation-score` | Numeric score returned by the simulation, if available. |

---

## Examples

### Minimal example

Submit the current commit to a Brotni API without waiting for results:

```yaml
name: Brotni Simulation

on: [push]

permissions:
  contents: read

jobs:
  simulate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: BROTNI/brotni-github-action@v1
        with:
          brotni-api-url: ${{ vars.BROTNI_API_URL }}
          brotni-token: ${{ secrets.BROTNI_TOKEN }}
          simulation-spec: simulation.yml
```

### PR candidate

Submit a pull request as a candidate, wait for the result, and post a comment and check:

```yaml
name: Brotni Simulation – PR

on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  contents: read
  pull-requests: write
  checks: write

jobs:
  simulate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Submit PR to Brotni Simulation
        id: brotni
        uses: BROTNI/brotni-github-action@v1
        with:
          brotni-api-url: ${{ vars.BROTNI_API_URL }}
          brotni-token: ${{ secrets.BROTNI_TOKEN }}
          simulation-spec: simulation.yml
          candidate-name: ${{ github.event.pull_request.title }}
          campaign-id: ${{ vars.BROTNI_CAMPAIGN_ID }}
          wait: 'true'
          publish-comment: 'true'
          publish-check: 'true'
```

See the full example in [`examples/basic-pr.yml`](examples/basic-pr.yml).

### OCI image candidate

Build and push an OCI image, then submit it as a simulation candidate using an immutable digest:

```yaml
- name: Build and push
  id: build
  uses: docker/build-push-action@v5
  with:
    push: true
    tags: ghcr.io/${{ github.repository }}:${{ github.sha }}

- name: Submit OCI artifact to Brotni
  uses: BROTNI/brotni-github-action@v1
  with:
    brotni-api-url: ${{ vars.BROTNI_API_URL }}
    brotni-token: ${{ secrets.BROTNI_TOKEN }}
    artifact-uri: ghcr.io/${{ github.repository }}:${{ github.sha }}
    artifact-digest: ${{ steps.build.outputs.digest }}
    simulation-spec: simulation.yml
    execution-recipe: recipes/container.yml
    wait: 'true'
    publish-check: 'true'
```

See the full example in [`examples/oci-artifact.yml`](examples/oci-artifact.yml).

### Wait for result and gate

Submit a candidate, wait for the simulation, and fail the workflow if it does not pass:

```yaml
- name: Submit and wait
  id: brotni
  uses: BROTNI/brotni-github-action@v1
  with:
    brotni-api-url: ${{ vars.BROTNI_API_URL }}
    brotni-token: ${{ secrets.BROTNI_TOKEN }}
    simulation-spec: simulation.yml
    wait: 'true'
    wait-timeout: '900'
    publish-comment: 'true'
    publish-check: 'true'

- name: Gate on result
  if: steps.brotni.outputs.simulation-status == 'failed'
  run: exit 1
```

See the full example in [`examples/wait-for-result.yml`](examples/wait-for-result.yml).

---

## Permissions

The action itself only calls the Brotni API and — if `publish-comment` or `publish-check` is enabled — the GitHub API.

| Feature | Required permission |
|---|---|
| Submit candidate (always) | `contents: read` |
| Post PR comment (`publish-comment: true`) | `pull-requests: write` |
| Create/update Check Run (`publish-check: true`) | `checks: write` |

Declare only the permissions your workflow actually uses:

```yaml
permissions:
  contents: read
  pull-requests: write  # only if publish-comment: true
  checks: write         # only if publish-check: true
```

---

## Security considerations

- **Never log secrets.** The action masks `brotni-token` and `github-token` immediately after reading them so they do not appear in workflow logs.
- **Use repository secrets** for `brotni-token`, not variables. Store the API URL in a repository variable (`vars.BROTNI_API_URL`) since it is not sensitive.
- **Pin to a SHA** for supply-chain safety in production workflows:
  ```yaml
  uses: BROTNI/brotni-github-action@<SHA>  # pin to a specific commit
  ```
- **Minimal permissions.** Do not grant `contents: write`, `actions: write`, or any other permission not listed above. The action does not need them.
- **No private endpoints hardcoded.** The action has no knowledge of any specific Brotni deployment. All endpoints are supplied at runtime via inputs or environment variables.
- **Immutable artifact references.** When submitting OCI images, prefer providing both `artifact-uri` and `artifact-digest`. The digest uniquely identifies the image layer set regardless of tag mutations.

---

## Publishing status, checks, and comments

### Check Run

Set `publish-check: 'true'` and ensure `checks: write` permission is granted. The action creates a check run in `in_progress` state immediately after submission, then updates it with the final conclusion once the simulation completes (when `wait: 'true'`).

```yaml
permissions:
  checks: write

- uses: BROTNI/brotni-github-action@v1
  with:
    publish-check: 'true'
    wait: 'true'
```

### PR Comment

Set `publish-comment: 'true'` and ensure `pull-requests: write` is granted. A comment is posted when the workflow is triggered by a `pull_request` event.

```yaml
permissions:
  pull-requests: write

- uses: BROTNI/brotni-github-action@v1
  with:
    publish-comment: 'true'
    wait: 'true'
```

### Step Summary

The action always writes a summary table to the workflow run summary page, regardless of `publish-comment` or `publish-check`.

---

## Using with brotni-cli

If your workflow already has `brotni-cli` installed, you can call it before this action to produce a simulation spec or recipe, then pass the path as an input:

```yaml
- name: Generate simulation spec
  run: brotni-cli spec generate --output simulation.yml

- uses: BROTNI/brotni-github-action@v1
  with:
    brotni-api-url: ${{ vars.BROTNI_API_URL }}
    brotni-token: ${{ secrets.BROTNI_TOKEN }}
    simulation-spec: simulation.yml
```

Alternatively, use `brotni-cli` to submit the candidate directly if you need fine-grained control, and use this action only for publishing the result back to GitHub:

```yaml
- name: Submit via CLI
  id: cli
  run: |
    result=$(brotni-cli submit --spec simulation.yml --format json)
    echo "candidate-id=$(echo $result | jq -r .candidate_id)" >> "$GITHUB_OUTPUT"

- uses: BROTNI/brotni-github-action@v1
  with:
    brotni-api-url: ${{ vars.BROTNI_API_URL }}
    brotni-token: ${{ secrets.BROTNI_TOKEN }}
    candidate-name: ${{ steps.cli.outputs.candidate-id }}
    wait: 'true'
    publish-check: 'true'
```

---

## Contributing

1. Fork the repository.
2. Install dependencies: `npm install`.
3. Make changes in `src/`.
4. Build the production bundle: `npm run build`.
5. Commit both `src/` and `dist/` changes.
6. Open a pull request.

---

## License

Apache License 2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
