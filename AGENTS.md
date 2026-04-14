# Repository Guidelines

## Project Structure & Module Organization
This repository is a small Node.js dashboard app centered on [server.js](/root/projects/pdca-ui/server.js). Application routes, auth, API handlers, and inline HTML/CSS currently live in that file. Runtime process settings are in [ecosystem.config.js](/root/projects/pdca-ui/ecosystem.config.js). Package metadata and scripts are in [package.json](/root/projects/pdca-ui/package.json). GitHub automation lives under `.github/workflows/`.

There is no dedicated `src/`, `tests/`, or static asset directory yet. If the app grows, prefer extracting route handlers and UI templates into focused modules rather than expanding `server.js` further.

## Build, Test, and Development Commands
Use:

- `npm install` to install dependencies.
- `npm start` to run the Express server locally on port `7010`.
- `node --check server.js` to catch syntax errors before committing.
- `npx pm2 start ecosystem.config.js` to run the app with the repository’s PM2 config.

No build step is defined; this is a direct Node runtime project.

## Coding Style & Naming Conventions
Follow the existing style in `server.js`: 2-space indentation, semicolons, single quotes, and `const` by default. Use `UPPER_SNAKE_CASE` for configuration constants such as `PORT` and `DB_PATH`, and `camelCase` for variables and functions such as `requireAuth`.

Keep route handlers small and defensive. Return JSON errors for `/api/*` endpoints and preserve the current explicit status checks and input validation patterns.

## Testing Guidelines
There is no automated test framework configured yet. Until one is added, contributors should:

- run `node --check server.js`
- start the app with `npm start`
- manually verify login flow and affected `/api/*` endpoints

When adding tests, place them in a top-level `tests/` directory and name files `*.test.js`.

## Commit & Pull Request Guidelines
Recent commits use short, imperative subjects such as `Add manual deploy workflow` and `Fix SSH port to 2222 in deploy workflow`. Keep commit messages focused on one change and start with a verb.

PRs should include:

- a concise summary of behavior changes
- linked issue or task reference when available
- screenshots or response samples for UI/API changes
- notes about manual verification performed

## Security & Configuration Tips
Avoid hardcoding new secrets. Prefer environment variables for credentials and session settings, following the existing `PDCA_SESSION_SECRET` pattern. Be careful with absolute filesystem paths like `/root/data/assistant/...`; document any new path dependency in the PR.
