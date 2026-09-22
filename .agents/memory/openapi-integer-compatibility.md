---
name: OpenAPI integer compatibility
description: Compatibility constraint between Orval output and the workspace's installed Zod runtime.
---

Use `type: number` for API quantities and IDs when generating Zod schemas in this workspace, with minimum/maximum or application-level integer validation where needed. OpenAPI `type: integer` currently makes Orval emit `zod.int()`, but the installed Zod runtime does not expose that function.

**Why:** The generated client still looked valid, but the API server crashed at import time with `TypeError: (void 0) is not a function`.

**How to apply:** After changing `lib/api-spec/openapi.yaml`, run codegen and the full workspace typecheck before restarting the API workflow.