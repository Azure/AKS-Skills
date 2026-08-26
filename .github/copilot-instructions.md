# GitHub Copilot instructions

- This repository is an AKS skills collection with evals, not a publication, manifest, provider, evidence, or benchmark platform.
- Start standalone work from live `main`. Do not create stacked PRs or mutate, rebase, retarget, merge, or force-push another branch or reviewed head unless a human explicitly requests that exact action.
- Reviewer-requested removals are binding negative requirements. Read the review history and do not recreate equivalent files, package scripts, workflow wiring, or tests under another name.
- Add a test only when it executes behavior required by the request or the existing skill contract. Do not add prose, inventory, manifest-mirroring, workflow-shape, matrix-shape, or change-detector assertions.
- Do not change `evals/package.json` or a workflow merely to register one-off verification; invoke the focused existing or direct command unless CI must execute the required behavior.
- Stop when deleting any remaining change would leave the requested behavior proven.
