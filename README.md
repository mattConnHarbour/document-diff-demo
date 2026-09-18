# Browser document comparison

A standalone, product-shaped comparison workflow built against the published
`superdoc@2.0.0-next.25` release. It compares an earlier DOCX to a revised DOCX through
the worker-backed browser Document API, applies the result as tracked changes,
and exports a review-preserving redline.

## What it demonstrates

- two-file, base-to-target comparison;
- browser-worker execution with a continuously animated responsiveness signal;
- truthful stage progress and per-stage timing;
- changed-component and applied-operation summaries;
- accept-all, reject-all, and redline export.

The public compare call is atomic and does not expose percentage completion, so
the UI intentionally uses an indeterminate indicator during that stage.

## Run

```bash
pnpm install
pnpm dev
```

Open <http://localhost:5190>.

## Build

```bash
pnpm build
```
