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

### 3. Setup Claude Code Authentication

The bot needs Claude Code CLI authenticated to work. Choose one method:

**Option A: Claude Max Subscription (Recommended)**

```bash
# Generate a long-lived OAuth token
claude setup-token

# You'll see output like:
# Your OAuth token (valid for 1 year):
# sk-ant-oat01-...
# Store this token securely.

# Export the token
export CLAUDE_CODE_OAUTH_TOKEN="sk-ant-oat01-your-full-token"

# Add to your shell profile for persistence
echo 'export CLAUDE_CODE_OAUTH_TOKEN="sk-ant-oat01-your-full-token"' >> ~/.bashrc
source ~/.bashrc

# Also add to .env for the bot
echo 'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-your-full-token' >> .env
```

**Option B: Anthropic API Key**

```bash
# Add to .env
echo 'ANTHROPIC_API_KEY=sk-ant-your-api-key' >> .env

# Or export directly
export ANTHROPIC_API_KEY="sk-ant-your-api-key"
```

**Verify authentication:**

```bash
claude -p "hi"
# Should respond without "Invalid API key" error
```

### 4. Setup Server

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

### 5. Connect via Slack

1. Copy the **Session Token** shown when the bot starts
2. DM the bot in Slack with the token
3. Create a new channel
4. Invite the bot to the channel
5. Start chatting!

## Configuration

Create a `.env` file:

```env
# Required - Slack tokens
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_APP_TOKEN=xapp-your-app-token

# Required - Claude Code authentication (choose one)
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-your-token  # From `claude setup-token`
# OR
# ANTHROPIC_API_KEY=sk-ant-your-api-key          # Direct API key

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

### Commands

| Command | Description |
|---------|-------------|
| `!interrupt` / `!stop` / `!esc` | Interrupt Claude (sends Ctrl+C) |
| `!reset` / `!new` | Start a new conversation |
| `!debug` / `!output` | Show terminal output |
| `!help` | Show available commands |

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
| `get_pending_messages` | Check for new messages from user |
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

### "Invalid API key" error

```bash
# Verify token is set
echo $CLAUDE_CODE_OAUTH_TOKEN

# Test authentication
claude -p "hi"

# If still failing, regenerate token
claude setup-token
# Copy the FULL token (it's very long!)
export CLAUDE_CODE_OAUTH_TOKEN="sk-ant-oat01-full-token-here"
```

### Bot not responding

- Check that both Slack tokens are correct in `.env`
- Ensure the bot is invited to the channel
- Check console for error messages

### Claude Code not starting

- Verify `claude` CLI is installed: `claude --version`
- Verify authentication: `claude -p "hi"`
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
