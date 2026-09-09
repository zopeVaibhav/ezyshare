# Security

ezyshare runs a daemon that listens on your local network and accepts input from it, so
the threat model is worth stating plainly.

## Reporting a vulnerability

Open a [security advisory](https://github.com/zopeVaibhav/ezyshare/security/advisories/new)
rather than a public issue. Please include what an attacker needs (same wifi, a machine on
the LAN, local access) and a request or packet that demonstrates the problem.

## What the daemon exposes

| Route     | Reachable by             | Gate                                                                                                |
| --------- | ------------------------ | --------------------------------------------------------------------------------------------------- |
| `/api/*`  | the paired extension     | loopback source, one pinned `chrome-extension://` origin, `X-Ezyshare` header                       |
| `/inbox`  | other daemons on the LAN | `X-Ezyshare-Peer` header, JSON content type, no `Origin`, rate limited, signed when a secret is set |
| `/whoami` | anyone on the LAN        | none; returns a display name and id                                                                 |

Both LAN-facing routes require a header a browser cannot set without a preflight, and
neither answers a preflight from a web origin. That is what stops a page you happen to
visit from injecting a link or reading your inbox.

## What is defended

- A malformed request cannot stop the daemon: a JSON body that parses to anything other
  than an object is replaced with an empty one, and the process survives an unhandled
  rejection.
- Inbound links must be non-loopback `http` or `https`, checked on the wire and again when
  reloading state from disk. `javascript:`, `file:`, `data:`, `0.0.0.0`, `[::]`,
  `[::ffff:127.0.0.1]`, `localhost.` and link-local are all refused.
- A peer id stays bound to the address and port that first announced it until its TTL
  expires, so overhearing a broadcast is not enough to become that peer.
- Announces are accepted only from the machine's own IPv4 subnets, and new peer ids are
  rate limited per source address.
- A sender's claimed identity is believed only when that id is a known peer at that exact
  source address. Anything else is shown as unverified.
- With `--secret` set, announces and deliveries are HMAC-signed with a timestamp and a
  single-use nonce.
- Handing the pairing to a different extension needs a six digit code the daemon prints to
  its own output, valid once for five minutes and rate limited, so a second extension
  cannot take the pin on its own.
- State files are `0600` inside a `0700` directory, and the log records hostnames rather
  than full URLs.

## What is not defended

- **Without `--secret`, any daemon on your network can send you a link.** It will be
  labelled unverified, but nothing stops it. Set a shared secret on untrusted networks.
- **LAN traffic is plain HTTP.** Anyone who can sniff the network sees the links you share
  and the display names you broadcast.
- **`/api` trusts the local machine.** Another user account or a compromised process on
  your own machine can read your inbox, send links as you, and turn sharing off.
- **Verification is by source address.** Two peers behind the same address cannot be told
  apart.
- **A peer can be impersonated across a restart** by someone who has learned its id and
  announces it continuously, unless a shared secret is set.

Do not run ezyshare on public wifi without `--secret`.
