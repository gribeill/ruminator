# Hosted entry point

See [the hosted guide](../../hosted.md) for preview commands, the security boundary, limitations, and deployment prerequisites.

- `worker.ts`: thin Worker entry point; no generation/inference bindings.
- `app.ts`: explicit routes, response/cache policy, and reading controls.
- `auth.ts`: Access JWT/JWKS validation and session/publication-bound CSRF forms.
- `reading-store.ts`: minimal D1 accounts/reading/vote queries; full generation persistence is a later slice.
- `default-interests.ts`: public starter document used only when provisioning new users.

Local identity/fixture code lives under `scripts/`, never in this Worker's import graph. `tsconfig.json` checks this entry point with Workers types separately from the standalone Node application.
