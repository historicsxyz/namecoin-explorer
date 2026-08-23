# Security Policy

Thank you for helping keep Namecoin Explorer and the people who self-host it safe.

## Supported versions

Only the latest release on `main` is currently supported with security fixes.
We recommend running the latest version.

## Reporting a vulnerability

**Please do NOT open a public GitHub issue for a security vulnerability.**

Instead, report privately. We will acknowledge, investigate, and — for a
validated, covered vulnerability — coordinate a responsible disclosure.

How to reach us:

- Open a **private** GitHub Security Advisory:
  <https://github.com/historicsxyz/namecoin-explorer/security/advisories/new>

## What to include

- The affected version(s) and the file/endpoint in question
- A minimal reproduction (URL, request payload, steps)
- Impact and any suggested fix, if you have one
- Whether the issue is already public

## Scope

The following are in scope:

- Remote code execution, injection, or SSRF in the web layer
- Exposure of RPC credentials or the cookie file
- Server-side request manipulation
- Authentication / authorization bypass
- Privacy leaks (e.g. revealing something that should be private)

The following are out of scope / by design:

- The node on port 8336 is **never** exposed — ensure your firewall keeps it
  loopback-only.
- Data that is inherently public on a public blockchain explorer is public.

## Process

1. You report privately.
2. Maintainer acknowledges within a few business days.
3. We triage, fix, and release a patched version.
4. After a reasonable embargo so users can update, the advisory is published.

Thanks to the researchers who help keep the ecosystem safe.