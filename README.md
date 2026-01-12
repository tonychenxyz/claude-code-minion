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

## Project Structure

```
.
├── app/                      # Bot application
│   ├── src/                  # TypeScript source
│   ├── dist/                 # Compiled JavaScript
│   ├── package.json
│   └── setup.sh
├── projects/                 # Your project files (Claude works here)
├── .claude/                  # Claude settings
├── .env                      # Configuration (create from .env.example)
├── .env.example
├── CLAUDE.md                 # Instructions for Claude Code
├── slack-app-manifest.yaml   # Slack app manifest
└── README.md
```

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
```

**Option B: Anthropic API Key**

```bash
export ANTHROPIC_API_KEY="sk-ant-your-api-key"
```

**Verify authentication:**

```bash
claude -p "hi"
# Should respond without "Invalid API key" error
```

### 4. Setup Server

```bash
# Clone the repo
git clone <this-repo> claude-code-minion
cd claude-code-minion/app

# Run setup
./setup.sh

# Configure tokens in .env (root directory)
nano ../.env
# Add: SLACK_BOT_TOKEN, SLACK_APP_TOKEN, CLAUDE_CODE_OAUTH_TOKEN

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

Create `.env` file in root directory:

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
WORKING_DIRECTORY=/path/to/your/projects  # Default: ../projects
```

## Usage

### Starting a Session

1. Run `cd app && npm start` on your server
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
- Check that the working directory exists (`projects/`)
- Look for errors in the terminal output

### Messages not being sent to Slack

- The orchestrator server must be running (port 3000 by default)
- Check MCP configuration in `app/.claude-minion/<channel-id>/mcp-config.json`

## Development

```bash
cd app

# Install dependencies
npm install

# Build
npm run build

# Start
npm start
```

## Security Notes

- Session tokens are short-lived and should be regenerated for new sessions
- The bot only has access to channels it's invited to
- Claude Code runs with the permissions of the user who started the server
- Consider running in a sandboxed environment for untrusted code

## License

MIT
