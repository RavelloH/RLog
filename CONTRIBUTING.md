# Contributing

Use Node.js 20 or newer. Install dependencies with `npm ci`, then run `npm run build` and `npm test` before proposing a change.

Keep runtime dependencies at zero. Changes to logging, file handling, Capture, or shutdown behavior require regression coverage. Test rotation on a Windows-compatible path: streams must be closed before rename. Do not change JSONL field names without documenting the migration impact.

Before release preparation, also run `npm pack --dry-run`. Publishing is performed separately and is not part of the repository test workflow.
