# Apature Gate Architecture

Created: 2026-06-15
Status: Gate-specific architecture record

## 1. Architecture Summary

Gate owns the GitHub product surface for Apature. It listens to PR and deployment signals, resolves a preview URL, schedules the current review, calls `judgment-engine`, and delivers the result back into GitHub.

Gate deliberately does not own model inference, screenshot capture internals, evaluation, or the preference dataset implementation. Those belong to `apatureai/judgment-engine`.

## 2. Request Flow

```mermaid
flowchart TD
  A["PR opened or synchronized"] --> B["Gate webhook receiver"]
  C["deployment_status: success"] --> B
  D["GitHub Action explicit preview URL"] --> B
  B --> E["Preview URL resolver"]
  E --> F["Queue review job keyed by repo#pr"]
  F --> G["Set current_sha[repo#pr]"]
  G --> H["Call judgment-engine"]
  H --> I["Gate publish guard checks current SHA"]
  I --> J{"Still newest PR head?"}
  J -- "no" --> K["Discard stale result"]
  J -- "yes" --> L["Update sticky PR comment"]
  L --> M["Update design-review Check Run"]
  M --> N["Record feedback hooks"]
```

Key rule:

- Queue supersession key is `repo#pr`.
- Completed review identity is `(pr, head_sha)`.

## 3. System Boundaries

```mermaid
flowchart LR
  subgraph Gate["apatureai/gate"]
    A["GitHub Action"]
    B["GitHub App"]
    C["Preview URL resolver"]
    D["Review queue and supersession"]
    E["Sticky PR comment"]
    F["Check Run"]
    G["Dashboard and billing"]
  end

  subgraph Engine["apatureai/judgment-engine"]
    H["Capture engine"]
    I["Repo context extractor"]
    J["Qwen3-VL critique"]
    K["Finding validation"]
    L["Feedback store"]
  end

  subgraph Future["Other Apature surfaces"]
    M["mcp-review"]
    N["pointer"]
    O["interactive-review"]
    P["ui-dna"]
  end

  D --> H
  H --> J
  J --> K
  K --> E
  E --> L
  M --> Engine
  N --> Engine
  O --> Engine
  P --> Engine
```

Gate calls the engine through a stable interface:

```ts
critique(images, context) -> Findings
```

In practice Gate may pass a higher-level `GateReviewRequest`; the engine remains the owner of capture, context, model, and validation details.

## 4. Deployment Modes

```mermaid
flowchart TD
  subgraph Action["GitHub Action path"]
    A1["Runs in customer runner"]
    A2["Explicit preview URL or local serve"]
    A3["Calls hosted critique API"]
    A4["Posts PR comment and Check Run"]
  end

  subgraph App["GitHub App path"]
    B1["Webhook receiver"]
    B2["Deployment status resolver"]
    B3["Hosted queue"]
    B4["Hosted engine call"]
    B5["Dashboard and feedback memory"]
  end

  A2 --> A3
  A3 --> A4
  B1 --> B2
  B2 --> B3
  B3 --> B4
  B4 --> B5
```

Action path:

- Best for adoption and OSS.
- Capture can happen inside the user's runner.
- Minimal persistent product state.

App path:

- Required for paid hosted usage.
- Enables durable feedback memory, dashboard, billing, and baseline comparison.

## 5. Data Flow

```mermaid
sequenceDiagram
  participant GH as GitHub
  participant Gate as Gate
  participant Queue as Review Queue
  participant Engine as Judgment Engine
  participant Store as Artifact and Feedback Store

  GH->>Gate: PR/deployment webhook
  Gate->>Gate: Resolve preview URL and config
  Gate->>Queue: Enqueue repo#pr with head_sha
  Queue->>Engine: Review current preview
  Engine->>Store: Store screenshots, JSON, annotations
  Engine-->>Gate: Review result and artifact routes
  Gate->>Gate: Publish-time SHA guard
  Gate->>GH: Sticky comment update
  Gate->>GH: Check Run update
  GH->>Gate: Feedback reaction or slash command
  Gate->>Store: Feedback event
```

Queue payloads should carry IDs, URLs, and metadata, not large artifacts. Screenshots and JSON live in object storage owned by the shared platform.

## 6. Failure Modes

| Failure | Gate behavior |
|---|---|
| No preview URL found | Post neutral Check Run with setup guidance; do not fail the PR |
| Preview returns auth wall | Report not reviewed and link to bypass/auth setup |
| Older job finishes late | Discard at publish guard |
| Engine returns invalid element refs | Publish only validated findings; show model/capture warning if needed |
| Screenshot capture unstable | Surface confidence caveat from engine |
| GitHub comment update conflict | Re-read sticky comment and retry with newest node |
| Feedback GET prefetch | No mutation; require POST, reaction, or command |
| Blocking finding in advisory mode | Check Run remains neutral |

## 7. Issue Ownership

Gate issues:

- Orchestrator and queue behavior.
- GitHub Action/App delivery.
- Sticky comment and Check Run UX.
- Dashboard, billing, config UI, and GTM.

Judgment Engine issues:

- Capture, context extraction, model adapters, validation, eval, data store, and shared security.

UI DNA issues:

- Token extraction, design genome schema, and canonical design standard.

MCP Review, Pointer, and Interactive Review issues:

- Their respective delivery surfaces and session/tool behavior.

## 8. Architecture Poster

The poster source is `poster_gate.html`.

Rendered artifact:

```text
gate_architecture.png
```

Render rule:

- Open `poster_gate.html`.
- Render at a 3020px-wide viewport.
- Screenshot the `.poster` element.
- Regenerate the PNG whenever the poster HTML or referenced icons change.
