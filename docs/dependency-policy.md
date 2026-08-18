# Dependency version policy

## Node version principle

The production runtime follows the Node.js **LTS** line rather than the Current line. Decision date: **2026-08-18**.

The Node.js release schedule used for this decision is:

- Node 24 (Krypton): start `2025-05-06`, LTS `2025-10-28`, maintenance `2026-10-20`, end `2028-04-30`.
- Node 26: start `2026-05-05`, LTS `2026-10-28`, maintenance `2027-10-20`, end `2029-04-30`.

Therefore this repository stays on **Node 24 LTS** for now, and all `@types/node` declarations stay on major **24** to match the runtime. Node 26 is a Current release on the decision date and is not adopted early merely because it has a higher major version.

## Re-evaluation trigger

Re-evaluate the runtime **after 2026-10-28**, when Node 26 enters LTS. A Node-major migration must be treated as one coordinated change: update the CI `node-version`, explicitly handle Corepack in CI for the newer Node line, and move every `@types/node` declaration to the matching runtime major. Do not advance only the type definitions ahead of the production runtime.

## Version source of truth

For npm packages, the authoritative version check is:

```sh
npm view <pkg> version
```

Search-engine results, cached package pages, and other search indexes are not version truth sources. They may lag the npm registry and must not be used to decide whether a repository dependency is current.
