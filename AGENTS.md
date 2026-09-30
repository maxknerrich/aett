# aett

TypeScript + Effect CLI for macOS/NixOS fleets. Nix is the engine; VitePlus is the toolchain.

- Read relevant `docs/`; resolve open decisions when they affect the task.
- Prefer the smallest correct design. Keep domain logic pure and integrations behind Effect services; consult the Effect skill.
- Put necessary tests in each package's `test/` folder. Add them only to protect application behavior that matters. Do not add smoke tests or tests that repeat declarations or library behavior.
- Update documented decisions when they change; let code explain implementation details.
- Keep generated Nix and plaintext secrets out of Git. Commit or open PRs only when asked.

## Effect source reference

- Before writing Effect code, read `.repos/effect/LLMS.md` and inspect relevant source, examples and tests in `.repos/effect/`.
- The reference is pinned to the workspace's Effect version. Prefer its APIs and examples over guesses or documentation for other versions; project conventions and the Effect skill guide application design.
- Treat `.repos/` as read-only reference material. Edit it only when explicitly asked, including subtree updates.
- Import application dependencies from their package names, never from `.repos/`. Keep vendored code outside workspace builds, linting, formatting and tests.
- See `.repos/README.md` for the upstream pin and subtree update command.
