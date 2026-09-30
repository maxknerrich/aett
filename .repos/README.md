# Reference repositories

Read-only upstream sources, added as squashed Git subtrees. Pin each one to the version the workspace uses.

| Path | Upstream | Pin |
| --- | --- | --- |
| `effect/` | https://github.com/Effect-TS/effect | `effect@4.0.0-rc.118` (`ad61db80efd52637e2901c5ee56b9e0fb4e8ac48`) |

After bumping `effect` in `pnpm-workspace.yaml`, move the subtree to the matching tag and update the pin above:

```sh
git subtree pull --prefix .repos/effect https://github.com/Effect-TS/effect.git effect@<version> --squash
```
