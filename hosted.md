# Hosted reader: local auth slice

The hosted version is under development. This slice supports public reading, invited-user identity, private reading/voting, and account provisioning. It does **not** run ingestion, models, scheduled generation, editors, or admin execution controls yet.

The standalone local app (`npm start`, `npm run serve`) is unchanged and requires no Cloudflare login.

## Try it locally

```sh
npm install
npm run dev:hosted
```

Open the loopback URL printed by the command. **Log in to your reader** opens a local example-account picker:

- `owner@example.test`: admin, whose saved fixture listing is public.
- `friend@example.test`: a different private fixture listing and independent votes.
- `new@example.test`: first-login provisioning, default interests, and the waiting-for-first-update page.

This picker substitutes for Cloudflare's emailed code while testing locally. It still issues real signed JWTs, verified against an ephemeral local JWKS server. It sends no email and makes no Cloudflare account, model, or paid API calls. Do not expose the preview or its fixture identity provider through a public tunnel.

Stop with Ctrl-C. Preview accounts, votes, and signing keys reset; existing `data/` databases and your personal `interests.md` are untouched. Fixture summaries/scores are explicitly synthetic, not real model results. No fixture users or publications should be seeded into a remote database.

## Route boundary

| Route | Behavior |
| --- | --- |
| `/` | Public admin publication, identical regardless of login; no vote forms or private account state. |
| `/assets/katex/*` | Public local CSS/fonts only. |
| `/login` | Sends the browser to the protected reader; real Cloudflare Access will handle email-code login. |
| `/logout` | Redirects to the Access logout endpoint; the local fixture clears its cookie. |
| `/reader` | Signed-in user's saved listing and voting forms, or a waiting message. |
| `/reader/vote` | Authenticated, origin/CSRF-checked POST for a paper in that user's current publication. |
| `/interests` | Read-only view of the user's Markdown for now. |
| `/admin` | Admin-only placeholder; configuration and generation controls are not implemented. |

Saving/editing and rebuild/regenerate endpoints are deliberately unavailable. An HTTP request cannot start a model call: the Worker has no inference, Workflow, or scheduling bindings.

## Identity and data

Cloudflare Access will own the invitation allowlist and email-code sessions. A valid application JWT for our configured issuer/audience represents an approved invitation. There is no second application invitation list or password system.

First login creates a regular D1 user with a stable UUID, verified issuer/subject identity, email, enabled flag, and the agreed six broad quantum-computing profiles. Defaults are valid immediately: no initial save is required for eligibility when scheduled generation is later implemented. Login and reading never generate a listing. An existing user's interests, enabled state, and role are not reset on re-login. Identity/email changes or collisions require operator review rather than automatic account linking.

The admin is explicitly provisioned in D1; neither JWT role claims nor editable TOML grant that role. A unique index permits only one admin. The preview script performs this provisioning for its synthetic owner only.

`schema/hosted.sql` currently defines accounts, latest per-user votes, and a normalized reading projection (publication pointer, small metadata, per-paper UI rows). It is **not** the full generation/source-cache schema or an adapter for local SQLite. Publication rows are immutable inputs to reading; the fixture writer creates a new ID on replacement. Full generation, pruning/365-day expiry, shared source caches, request accounting, and in-flight-reader-safe cleanup remain later slices. Development schemas have no migrations.

## Security choices

- Pinned `jose` verifies RS256 signatures and issuer, audience, application-token type, subject/email, expiry, and issue time. Seven days is the maximum accepted session age/duration. Signing keys come only from the configured issuer's bounded JWKS endpoint and are cached for rotation; token-provided key URLs and unverified email headers are not trusted.
- The assertion header takes precedence; a bad assertion cannot fall back to a different valid cookie. Cookie-only requests still undergo the same JWT verification.
- A local HTTP issuer is allowed only alongside a loopback HTTP application origin. There is no skip-auth flag or hardcoded signing key in the Worker. Every request must match `PUBLIC_ORIGIN`, so alternate Worker hostnames cannot bypass the boundary. Proxy/forwarded headers do not choose the issuer or redirect destination.
- Every private request reads the D1 enabled state/role. Private pages, redirects, and errors use `private, no-store`. Public output never depends on login; static paper rendering is reused per publication and audience, with only authorized votes/forms assembled live.
- Forms use a per-user HMAC bound to the JWT session and publication. POSTs require the exact application Origin, a bounded form body, and exactly the expected fields. The vote transaction rechecks enabled state, ownership, current publication, and membership. Repeated desired states do not renew vote timestamps.
- Paper text and interests are escaped; KaTeX trust features remain off. Pages use a restrictive CSP and no browser JavaScript. Credentials, JWTs, and raw authentication errors are not logged or returned.

For immediate removal, **disable the D1 user as well as removing their Access invitation and revoking their Access sessions**. Offline JWT verification cannot discover per-session revocation by itself. Access's [logout endpoint](https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/session-management/#log-out-as-a-user) clears its browser cookie and revokes sessions at the edge; Cloudflare documents a 20–30 second propagation delay. Disabling the application user blocks subsequent private requests without waiting for token expiry. The local fixture demonstrates cookie logout, not real Cloudflare revocation.

## Tests

```sh
npm test
npm run typecheck
```

The auth integration checks use real RSA signatures, a loopback JWKS HTTP server, workerd, D1, and local KaTeX assets. They cover identity rejection, provisioning, private ownership/cache isolation, disabled accounts, role spoofing, CSRF/session/publication binding, idempotent voting, and login/logout routing. No real Access application or email service is required. Existing scientific/local tests remain available. The completed feasibility probes have been removed; their architecture findings are retained in `.agents/PLAN.md`.

## Deploy together, after local review

No resources have been created or changed for this slice. Before a first auth-only deployment we will:

1. Create/select a real D1 database and apply the current schema explicitly; do not run the fixture seeder remotely.
2. Configure `PUBLIC_ORIGIN` as the chosen HTTPS subdomain and set the real Access team issuer and application audience. Replace the dummy D1 ID. Keep `workers_dev` and preview URLs disabled.
3. Configure an Access email-code application/allowlist and seven-day sessions. Verify **all bare private paths and their descendants**, including the vote endpoint, are covered by the configured application audience. Keep `/` and assets public; do not put an Access challenge in front of the entire site. Resolve any dashboard path/application-audience constraints before opening access.
4. Sign in as the owner, inspect the verified D1 identity, then grant the sole admin role by that stable user ID. Invitation/role management remains manual. Remove access by disabling the user, removing the allowlist entry, and revoking sessions—not by deleting their row and permitting re-provisioning.
5. Check anonymous public reading, real emailed login, private reads/votes, logout, account disabling, cache headers, and alternate-host denial on Cloudflare.

This initial deployment can validate authentication without inference. Real hosted generation and summary costs remain disabled until the subsequent storage/generation slices and their explicit activation review. No Hugo rebuild or personal-site repository change is required.
