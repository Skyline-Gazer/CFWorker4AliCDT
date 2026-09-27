# Manual SMTP test

The authenticated donor `send_test_email` action is available only when Worker
bindings `SMTP_HOST` and `SMTP_FROM` are present and the owner gate
`ENABLE_MANUAL_SMTP_TEST` is set to `1`, `true`, or `yes` (case insensitive).
The gate is off by default. Browser SMTP credentials are never used. A valid
email in the request's `email` field can select the recipient; otherwise the
configured sender address is used.

Workers do not provide Node SMTP libraries such as nodemailer. The notifier uses
the official `cloudflare:sockets` TCP API. Port 25 is prohibited by Cloudflare.
Port 465 uses implicit TLS; port 587 (the default) and other non-25 ports use
STARTTLS. The implementation is a minimal SMTP client with optional AUTH LOGIN,
not a full MTA: it does not implement retries, MIME attachments, or advanced
mail policies. SMTP credentials remain in Worker bindings.
