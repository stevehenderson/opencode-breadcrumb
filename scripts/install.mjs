#!/usr/bin/env node
// Breadcrumb enrollment.
//
// Thin wrapper around crumb's shared installer so enrollment has a single
// implementation; equivalent to `crumb install`. Copies the plugin and the
// shared state module into ~/.config/opencode/plugins/. No build step:
// opencode runs the TypeScript directly.
//
// Usage: node scripts/install.mjs [--dest <dir>]   (default ~/.config/opencode/plugins)

import { runInstall } from "../probe/crumb.ts";

process.exitCode = await runInstall(process.argv.slice(2));
