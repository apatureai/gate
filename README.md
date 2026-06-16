# Apature Gate

GitHub-native design review for AI-generated frontend PRs.

Apature Gate screenshots a pull request's preview deploy, asks Apature's shared judgment engine to critique the rendered UI against the repo's design system and UI DNA, then posts one annotated PR review and one GitHub Check Run.

Applitools checks pixels. Apature checks judgment.

## What This Repo Is

This is the main MVP/product repo for the Apature startup wedge. It owns the GitHub product surface:

- GitHub Action and GitHub App behavior.
- Preview URL discovery and review orchestration.
- Sticky PR comments and Check Runs.
- Gate-specific configuration, dashboard, billing, GTM, and YC demo docs.

It does not own the shared capture/model/eval substrate. That belongs to `apatureai/judgment-engine`.

## Docs

- [RESEARCH.md](RESEARCH.md) - market, technical, and architecture backing for the Gate wedge.
- [PRD.md](PRD.md) - YC-ready product requirements and wedge narrative.
- [TRD.md](TRD.md) - build-ready technical requirements for the MVP.
- [ARCHITECTURE.md](ARCHITECTURE.md) - diagrams, data flow, repo boundaries, and failure modes.
- [BACKLOG.md](BACKLOG.md) - GitHub issue execution order and dependency map.
- [gate_architecture.png](gate_architecture.png) - one-page architecture poster.
- [poster_gate.html](poster_gate.html) - editable source for the poster.

## Current MVP Focus

The first product must make one workflow undeniable:

1. An AI-generated frontend PR opens.
2. Gate finds the preview deploy.
3. Gate reviews the rendered UI through `judgment-engine`.
4. Gate posts annotated findings in GitHub.
5. The developer or their agent fixes the issue.
6. Gate verifies the newest PR head.

## Start Here

The first build issue is [#30](https://github.com/apatureai/gate/issues/30): scaffold the service, Action entrypoint, and shared types package. Then follow [BACKLOG.md](BACKLOG.md). Do not start with dashboard, billing, baseline comparison, or marketplace work until the M1 Action-path vertical slice is running against a mock engine.

## Product Boundary

Gate judges and verifies. It never edits customer code, never commits fixes, and never asks for `contents: write`.

Default Check Runs are advisory. A repository must explicitly opt into blocking before a design finding can fail a merge gate.

## Architecture

![Apature Gate architecture](gate_architecture.png)
