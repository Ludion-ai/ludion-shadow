# ludion-shadow

This repository runs the scheduled part of [Ludion](https://github.com/Ludion-ai/ludion)'s shadow operation. A recorder follows the public npm registry and OSV for a fixed list of packages and keeps what Ludion's judge would read, so that the judge can later be replayed against it. It records; it judges nothing and changes nothing anywhere.

- **No secrets.** The workflows use only the token GitHub gives each run, and hold no other credential.
- **Public data only.** What it stores is public registry data: package names, versions, publish times, manifests without e-mail addresses, attestations and file lists. No project's source or usage is sent or kept here.
- **Where the data goes.** The branch `shadow-data`, not `main`.
