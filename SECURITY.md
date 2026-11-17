# Security policy

## Supported versions

Only the latest release receives security fixes.

## Report a vulnerability

Do not open a public issue for a security vulnerability. Report it privately through GitHub instead:

1. Go to the [Security tab](https://github.com/iHideck/asc-mcp/security) of this repository.
2. Click **Report a vulnerability**.
3. Describe the problem, how to reproduce it, and its impact.

Do not include your own private key, Issuer ID, or Key ID in the report.

You will get a reply within 14 days. After a fix is released, the advisory is published with credit to you unless you ask otherwise.

## Scope

asc-mcp reads your App Store Connect API private key from `~/.appstoreconnect/private_keys/` and sends requests only to `api.appstoreconnect.apple.com` and to the upload URLs that the API returns. Report any behavior that sends your key, tokens, or App Review contact details anywhere else, or that writes to App Store Connect without the confirmation the tool describes.
