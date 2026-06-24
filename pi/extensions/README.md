# Custom Extensions

This directory contains custom extensions for pi-coding-agent.

## Usage

Extensions are auto-discovered when placed in `~/.pi/agent/extensions/`. Use `pi -e ./path.ts` to load explicitly.

## Available Extensions

### server-timeout-guard.ts

Automatically adds a 30-second timeout to server-like commands that would otherwise run indefinitely.

**Detects common patterns:**
- `bun run` / `bun start`
- `dotnet run` / `dotnet watch run`
- `npm start` / `npm run` / `yarn start` / `pnpm start`
- `node index.js` / `node server.js` / `node app.js`
- `python main.py` / `python server.py` / `flask run` / `uvicorn`
- `go run`
- `rails server` / `bundle exec rails server`
- `mix phx.server`

**Example:**
```bash
# Load extension
pi -e ~/.pi/agent/extensions/server-timeout-guard.ts

# Any server command will automatically get a 30s timeout
# No need to worry about forgetting to add --timeout!
```

## Writing Extensions

See the official [pi-coding-agent docs](https://github.com/badlogic/pi-mono/blob/main/docs/extensions.md) for full documentation.

## Contributing

Add new extensions to this directory and consider sharing them with the community!
