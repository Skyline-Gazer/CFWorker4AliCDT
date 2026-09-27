# Manual SMTP test

The authenticated donor `send_test_email` action is available only when Worker
bindings `SMTP_HOST` and `SMTP_FROM` are present and the owner gate
`ENABLE_MANUAL_SMTP_TEST` is set to `1`, `true`, or `yes` (case insensitive).
The gate is off by default and must not be enabled in production without a
separate owner authorization. Browser SMTP credentials are never used. A valid
email in the request `email` (or `to`) field can select the recipient; otherwise
the configured `SMTP_FROM` address is used.

## Why not nodemailer?

Cloudflare Workers do not provide a Node.js SMTP stack. Libraries such as
nodemailer depend on Node `net`/`tls` and are not available in the Worker
runtime. This project therefore does not add nodemailer or an HTTP email SaaS
dependency for the donor test action.

## Transport

The notifier (`src/notify/smtp.ts`) uses the official `cloudflare:sockets` TCP
API (`connect`). Cloudflare prohibits outbound TCP to **port 25**. Supported
paths:

- **465** — implicit TLS (`secureTransport: "on"`)
- **587** (default) and other non-25 ports — STARTTLS is **required**
  (`secureTransport: "starttls"` then `STARTTLS` + `startTls()`). Plaintext
  servers without STARTTLS are not supported (fail closed with `{ ok: false }`).

Optional `SMTP_USER` / `SMTP_PASS` use SMTP `AUTH LOGIN`. The client is minimal:
greeting → EHLO → (STARTTLS) → AUTH → MAIL/RCPT/DATA → QUIT. It is not a full
MTA (no MIME multipart, attachments, DSN, connection pooling, or retries).
Transport failures return `{ ok: false }` and never throw into the HTTP
control path. Credentials and AUTH payloads are never logged.

Connect is injected for unit tests so CI never opens live sockets.
