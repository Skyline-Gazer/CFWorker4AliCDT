## Summary

Describe the change and its user or operator impact.

## Documentation review

- [ ] API route, method, authentication, status, or donor-action changes are reflected in docs/operations/api.md and README.md.
- [ ] Runtime bindings, secrets, defaults, or feature gates are reflected in docs/operations/configuration.md.
- [ ] Deployment workflow, inputs, migration, Cron, or token-install changes are reflected in docs/operations/deployment.md.
- [ ] Health probe, classification, incident, or signal changes are reflected in docs/operations/monitoring.md.
- [ ] Security boundaries are reflected in docs/security/invariants.md and docs/security/ram-policy.md when relevant.
- [ ] Relative Markdown links and documented workflow/config names pass the documentation checks.

Reminder: a GitHub Release tag and notes do not deploy a Cloudflare Worker. Production state changes only through the appropriate owner-gated workflow.

Issue references in commits and PR text should use Refs #<issue>, not closes/fixes/resolves, unless closure is explicitly intended.
