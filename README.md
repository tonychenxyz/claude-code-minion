# Claude Code Minion

Talk to Claude Code running on a remote server through Slack. The server initiates all connections (Socket Mode), so no incoming ports need to be exposed.

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                           Remote Server                               │
│                                                                       │
│  ┌─────────────────────┐      ┌────────────────────────────────────┐ │
│  │   Main Orchestrator │      │  Claude Code + MCP (Channel #1)    │ │
│  │   (Slack Socket     │◄────►│  - PTY terminal                    │ │
│  │    Mode Bot)        │      │  - slack-messenger MCP             │ │
│  │                     │      └────────────────────────────────────┘ │
│  │  - Session tokens   │      ┌────────────────────────────────────┐ │
│  │  - Channel mapping  │◄────►│  Claude Code + MCP (Channel #2)    │ │
│  │  - Message routing  │      └────────────────────────────────────┘ │
│  └──────────┬──────────┘                                             │
│             │ WebSocket (server-initiated)                           │
└─────────────┼────────────────────────────────────────────────────────┘
              ▼
       [ Slack API ]
```

## Features

- **Socket Mode**: Server initiates WebSocket connection to Slack (no exposed ports)
- **Multi-channel**: Each Slack channel gets its own Claude Code instance
- **MCP Integration**: Claude Code communicates back via MCP tools:
  - Send markdown messages
  - Send files
  - Tag/mention users for input
  - Notify about actions and results
- **Session Tokens**: Secure pairing between Slack users and server sessions

## Quick Start

### 1. Create Slack App

1. Go to [Slack API](https://api.slack.com/apps)
2. Click "Create New App" → "From an app manifest"
3. Select your workspace
4. Paste the contents of `slack-app-manifest.yaml`
5. Click "Create"

### 2. Get Tokens

After creating the app:

1. Go to **OAuth & Permissions** → Install to Workspace
2. Copy the **Bot User OAuth Token** (starts with `xoxb-`)

3. Go to **Basic Information** → App-Level Tokens
4. Click "Generate Token and Scopes"
5. Name: `socket-mode`, Scope: `connections:write`
6. Copy the **App Token** (starts with `xapp-`)

### 3. Setup Server

```bash
# Clone the repo to your working directory
git clone <this-repo> my-project
cd my-project

# Run setup
./setup.sh

# Configure tokens
nano .env
# Add your SLACK_BOT_TOKEN and SLACK_APP_TOKEN

# Start the bot
npm start
```

### 4. Connect via Slack

1. Copy the **Session Token** shown when the bot starts
2. DM the bot in Slack with the token
3. Create a new channel
4. Invite the bot to the channel
5. Start chatting!

## Configuration

Create a `.env` file:

```env
# Required
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_APP_TOKEN=xapp-your-app-token

# Optional
ORCHESTRATOR_PORT=3000
WORKING_DIRECTORY=/path/to/your/project
```

## Usage

### Starting a Session

1. Run `npm start` on your server
2. Note the session token displayed
3. DM the Slack bot with the token
4. You're connected!

### Creating Claude Code Instances

1. Create a new Slack channel (e.g., `#project-feature-x`)
2. Invite the bot: `/invite @Claude Code`
3. A new Claude Code terminal is spawned for this channel
4. Send messages to interact with Claude

### Multiple Projects

You can run multiple instances:

```bash
# Terminal 1 - Project A
cd /path/to/project-a
npm start

# Terminal 2 - Project B
cd /path/to/project-b
npm start
```

Each will show a different session token. Use different Slack channels for each.

## MCP Tools

Claude Code in each session has access to these MCP tools for communicating via Slack:

| Tool | Description |
|------|-------------|
| `send_message` | Send markdown message to channel |
| `send_file` | Upload file to channel |
| `request_input` | @mention user for input |
| `notify_action` | Notify about action being taken |
| `notify_result` | Notify about action result |

## Project Structure

```
.
├── src/
│   ├── index.ts          # Main entry point
│   ├── slack-bot.ts      # Slack bot (Socket Mode)
│   ├── session-manager.ts # Session token management
│   ├── terminal-manager.ts # PTY terminal management
│   ├── mcp-server.ts     # MCP server for Claude Code
│   └── types.ts          # TypeScript types
├── slack-app-manifest.yaml # Slack app manifest
├── CLAUDE.md             # Instructions for Claude Code
├── setup.sh              # Setup script
└── package.json
```

## Troubleshooting

### Bot not responding

- Check that both tokens are correct in `.env`
- Ensure the bot is invited to the channel
- Check console for error messages

### Claude Code not starting

- Verify `claude` CLI is installed: `claude --version`
- Check that the working directory exists
- Look for errors in the terminal output

### Messages not being sent to Slack

- The orchestrator server must be running (port 3000 by default)
- Check MCP configuration in `.claude-minion/<channel-id>/mcp-config.json`

## Development

```bash
# Install dependencies
npm install

# Run in development mode
npm run dev

# Build for production
npm run build
npm run mcp:build

# Start production
npm start
```

## Security Notes

- Session tokens are short-lived and should be regenerated for new sessions
- The bot only has access to channels it's invited to
- Claude Code runs with the permissions of the user who started the server
- Consider running in a sandboxed environment for untrusted code

## License

MIT
