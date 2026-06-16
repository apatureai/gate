# Apature Gate - Research And Positioning

Created: 2026-06-16
Status: research-backed product and architecture memo

## 1. Research Question

Is Gate a unique and defensible YC-ready product, or is it just a wrapper around visual testing, AI code review, or browser agents?

Conclusion:

Gate is a strong wedge if it stays narrow: GitHub-native design judgment for rendered AI-generated frontend PRs. The unique product is not a generic VLM call. The unique product is the neutral PR boundary, repo-specific UI DNA, grounded screenshot evidence, agent-actionable suggestions, and feedback data loop.

## 2. Existing Categories

### Visual Testing

Sources:

- [Applitools](https://applitools.com/)
- [Chromatic visual testing for Storybook](https://www.chromatic.com/storybook)
- [Percy by BrowserStack](https://www.browserstack.com/percy)

What exists:

- Visual diffing and AI-assisted visual regression.
- Component and cross-browser visual testing.
- PR checks that detect UI changes or visual bugs.

Implication:

Gate should not sell "we compare screenshots." That market exists. Gate should sell design judgment: "this hard-coded color violates your UI DNA," "this hierarchy is off for this product," "this mobile CTA drifted from the system," and "here is the concrete agent-actionable fix."

### AI Code Review

Sources:

- [GitHub Copilot code review docs](https://docs.github.com/copilot/using-github-copilot/code-review/using-copilot-code-review)
- [GitHub Copilot code review concepts](https://docs.github.com/en/copilot/concepts/agents/code-review)

What exists:

- AI PR reviewers can inspect code, identify issues, and suggest fixes.
- GitHub Copilot review is a platform-native code-review surface.

Implication:

Gate should not compete as another source-code reviewer. It should inspect the rendered preview because many design failures are only obvious after the UI is built.

### Browser And Computer-Use Agents

Sources:

- [OpenAI computer use docs](https://developers.openai.com/api/docs/guides/tools-computer-use)
- [Playwright MCP docs](https://playwright.dev/docs/getting-started-mcp)
- [Playwright MCP repository](https://github.com/microsoft/playwright-mcp)
- [Stagehand](https://stagehand.dev/)

What exists:

- Agents can inspect screenshots, operate software, or use structured accessibility snapshots.
- Playwright MCP is especially important because it uses accessibility snapshots and element references rather than pixel-only interaction.

Implication:

Gate should not become a browser agent. Gate's trust comes from judging and verifying at the PR boundary while leaving code changes to the user's agent. Future Apature surfaces can use UI Graph and MCP, but Gate must remain the revenue wedge.

### Multimodal Models

Sources:

- [Qwen3-VL repository](https://github.com/QwenLM/Qwen3-VL)
- [Qwen3-VL technical report](https://arxiv.org/abs/2511.21631)

What exists:

- Modern VLMs are good enough to make image-grounded reasoning, OCR, spatial reasoning, and agentic multimodal workflows plausible.
- Qwen3-VL is a reasonable current default through `judgment-engine`, with model choice kept outside Gate.

Implication:

Gate can rely on VLM progress, but the moat cannot be "we use a VLM." The moat is per-repo design memory, element grounding, neutral delivery, feedback outcomes, and evaluation data.

## 3. Architecture Backing

### GitHub-Native Delivery

Sources:

- [GitHub Check Runs API](https://docs.github.com/rest/checks/runs)
- [GitHub status checks](https://docs.github.com/articles/about-status-checks)
- [GitHub App permissions](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app)
- [GitHub deployment status API](https://docs.github.com/rest/deployments/statuses)
- [GitHub webhook payloads](https://docs.github.com/en/webhooks/webhook-events-and-payloads)

Implications:

- GitHub is the right surface because the PR is where AI-generated frontend work is reviewed.
- Advisory checks are a good default because GitHub treats neutral as successful for dependent checks, while teams can opt into blocking later.
- Minimal GitHub App permissions support the neutrality story.
- Deployment status and preview URLs are the correct hosted-path signal, but Gate must verify source and SHA before handing a URL to the engine.

### Action-Path Security

Sources:

- [GitHub Actions secure use reference](https://docs.github.com/en/actions/reference/security/secure-use)
- [GitHub Security Lab on preventing pwn requests](https://securitylab.github.com/resources/github-actions-preventing-pwn-requests/)

Implications:

- The Action path must warn against `pull_request_target` with untrusted code and secrets.
- Fork PRs must disable auth state and preview bypass secrets.
- The hosted App path must be the stronger paid path for customers who care about isolation.

## 4. What Makes Gate Unique

Gate's defensible product shape:

- It is PR-native, not a separate QA dashboard first.
- It reviews rendered UI, not just source code.
- It judges design quality, not just visual difference.
- It is neutral: the generator does not grade itself.
- It is repo-specific through UI DNA.
- It gives concrete element-grounded suggestions to the developer or agent.
- It captures feedback and fix outcomes that become the team's design memory.

## 5. Product Risks To Respect

Generic-feedback risk:

- A vague design bot is worse than no bot. The finding budget must be small and evidence-grounded.

Incumbent-expansion risk:

- Visual testing vendors may add more AI summaries, and AI code reviewers may add screenshots. Gate's answer is repo-specific judgment plus GitHub-native delivery.

Architecture-sprawl risk:

- Gate can accidentally become the whole platform. Keep capture, model calls, eval, UI Graph, MCP, and live pointer surfaces in their own repos.

Security-trust risk:

- A no-write product can still mishandle sensitive preview data. Treat artifact security, source verification, and tenant isolation as first-order product features.
