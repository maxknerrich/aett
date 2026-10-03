# create-aett

Starts an [aett](https://www.npmjs.com/package/aett) fleet in a new directory:

```sh
npm create aett            # or: pnpm create aett, vp create aett
```

It runs `aett create` with the same arguments. It asks for the fleet's name and your login name, takes your SSH key from the agent and asks for the first machines; on a Mac it offers the Mac itself. Then it writes `fleet.ts`, makes the fleet a Git repository and installs aett into it.

MIT
