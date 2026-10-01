#!/usr/bin/env node
// `npm create aett`, `pnpm create aett` and `vp create aett` run this package's bin:
// it is `aett create` with the same arguments.
process.argv.splice(2, 0, "create");

await import("aett/cli");
