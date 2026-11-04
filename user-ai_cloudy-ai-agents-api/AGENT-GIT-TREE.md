# Agent Git Tree Reference

This document describes the shared git checkout available to every agent
container in this infrastructure.

## Location

All repositories live under `/home/appuser/git`. This tree is mounted into
this container from the host and is **shared** with the other agent containers
running on the same box. It is not a private clone. If you modify or commit
inside one container, every other container sees your changes immediately.

## Repositories Present

The following repositories are checked out at `/home/appuser/git`:

- `cloud-data`
- `cloud-me-pvt-my-ai`
- `cloud-infra`
- `cloud-u-android`
- `cloud-u-containers` (this repository)
- `cloud-u-linux`

The list above reflects the actual state of the filesystem; it is not a
static manifest. Repositories may be added or removed over time.

## How Git Accepts the Checkout

Ordinarily, git inside a container would reject a checkout owned by a
different uid, or one mounted from outside the container's own filesystem
namespace. That is not a problem here because the host injects the `safe.directory`
configuration through the **GIT_CONFIG environment triple** rather than through
any `.gitconfig` file on disk.

The triple is:

- `GIT_CONFIG_COUNT`
- `GIT_CONFIG_KEY_<N>`
- `GIT_CONFIG_VALUE_<N>`

These variables instruct git to treat the value as if it came from a config
file, without the file having to exist. One of the keys in that triple is
`safe.directory`, set to `*` (or to `/home/appuser/git`). This is why `git`
commands inside the container work despite the foreign ownership.

Because the configuration is injected through environment variables, editing
`~/.gitconfig` or `/etc/gitconfig` would have no effect on the safe-directory
behavior — those files are either absent or overridden by the environment
triple.

## Push Authentication

When you push, git invokes a credential helper. The helper is also configured
through the same GIT_CONFIG triple — the key `credential.helper` is set to a
shell command that echoes `username=...` and `password=$GH_TOKEN`. The
`GH_TOKEN` environment variable is in turn provided to the container from the
host, and it carries a GitHub personal access token with appropriate repository
permissions.

In short: pushes work because the environment triple tells git which credential
helper to call, and the credential helper answers with the token from
`GH_TOKEN`. No `~/.git-credentials` file is involved.
## Container Identity

The container that maintains this shared tree runs as real uid 10001 and gid 999. This matters because the shared git checkout is owned by that same uid: a container running as any other uid can read the tree but cannot write to it.
