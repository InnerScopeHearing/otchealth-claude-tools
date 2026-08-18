#!/usr/bin/env node
// secret-backend.mjs — print the NORMALIZED active secret backend, and nothing else.
//
// WHY THIS EXISTS: setup/session-start.sh decided which hydrator to run with a bare string
// comparison, `[ "$SECRET_BACKEND" = "ssm" ]`, while every Node caller in the fleet went through
// secretBackend() in skills/kb-memory/azure-secret.mjs, which trims, lowercases, and maps an
// unrecognised value to "ssm". Two parsers for one setting is two answers for one setting:
// SECRET_BACKEND="SSM" (or " ssm", or "Ssm", or a typo) made the SHELL skip the AWS hydrator
// entirely -- so the session started with no credentials -- while every Node tool it then launched
// happily read from SSM. The shell and the JS disagreed about which cloud was live, and neither
// said so.
//
// It was self-perpetuating, too: session-start.sh writes SECRET_BACKEND into
// ~/.designer/credentials.env, which the shell profile re-sources into every later shell, so one
// bad value survived the session that introduced it.
//
// The fix is not a second normalizer written in bash -- that would be the same bug with an extra
// copy. The shell asks the JS. secretBackend() stays the single definition; this is a two-line
// window onto it.
//
//   SECRET_BACKEND=" SSM " node setup/secret-backend.mjs   # -> ssm
//   SECRET_BACKEND=keyvault node setup/secret-backend.mjs  # -> keyvault
//
// Prints with NO trailing newline, so `$(...)` in the shell needs no stripping. Exits 0 always:
// a caller that cannot run node must be able to fall back to the same "ssm" default rather than
// abort session startup, so failure here is never fatal.

import { secretBackend } from '../skills/kb-memory/azure-secret.mjs';

process.stdout.write(secretBackend());
