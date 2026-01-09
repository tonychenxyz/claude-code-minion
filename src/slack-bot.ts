import { App, LogLevel } from '@slack/bolt';
import { SessionManager } from './session-manager.js';
import { TerminalManager } from './terminal-manager.js';
import * as http from 'http';

export class SlackBot {
  private app: App;
  private sessionManager: SessionManager;
  private terminalManager: TerminalManager;
  private orchestratorServer: http.Server | null = null;
  private botUserId: string = '';
  private workingDirectory: string;

  constructor(
    botToken: string,
    appToken: string,
    workingDirectory: string,
    sessionManager: SessionManager,
    terminalManager: TerminalManager
  ) {
    this.workingDirectory = workingDirectory;
    this.sessionManager = sessionManager;
    this.terminalManager = terminalManager;

    this.app = new App({
      token: botToken,
      appToken: appToken,
      socketMode: true,
      logLevel: LogLevel.INFO,
    });

    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    // Handle DMs - session token configuration
    this.app.message(async ({ message, say, client }) => {
      // Ignore bot messages
      if ('bot_id' in message) return;
      if (!('user' in message) || !('channel' in message)) return;

      const channelType = (message as any).channel_type;
      const text = ('text' in message ? message.text : '') || '';
      const userId = message.user as string;
      const channelId = message.channel;

      // DM handling - session token
      if (channelType === 'im') {
        await this.handleDM(userId, channelId, text, async (msg: string) => {
          await say(msg);
        });
        return;
      }

      // Channel message - forward to Claude Code
      await this.handleChannelMessage(channelId, userId, text, client);
    });

    // Handle bot being added to a channel
    this.app.event('member_joined_channel', async ({ event, client }) => {
      if (event.user !== this.botUserId) return;

      const channelId = event.channel;
      const inviterId = event.inviter;

      if (!inviterId) {
        console.log('No inviter found for channel join');
        return;
      }

      // Check if inviter has a session
      const session = this.sessionManager.getSessionByUserId(inviterId);
      if (!session) {
        await client.chat.postMessage({
          channel: channelId,
          text: `Hello! To use me, please DM me your session token first. You can get a session token by running the minion setup on your server.`,
        });
        return;
      }

      // Check if channel already has a session
      if (this.sessionManager.getChannelSession(channelId)) {
        await client.chat.postMessage({
          channel: channelId,
          text: `Claude Code is already running in this channel. Send a message to interact with it.`,
        });
        return;
      }

      // Create channel session and spawn Claude Code
      await this.spawnClaudeCodeForChannel(channelId, session.token, inviterId, client);
    });

    // Handle app mentions
    this.app.event('app_mention', async ({ event, client }) => {
      const channelId = event.channel;
      const userId = event.user;
      if (!userId) return;
      const text = event.text.replace(/<@[A-Z0-9]+>/gi, '').trim();

      await this.handleChannelMessage(channelId, userId, text, client);
    });
  }

  private async handleDM(
    userId: string,
    channelId: string,
    text: string,
    say: (msg: string) => Promise<void>
  ): Promise<void> {
    const trimmedText = text.trim().toUpperCase();

    // Check if it's a session token (8 character hex)
    if (/^[A-F0-9]{8}$/.test(trimmedText)) {
      const session = this.sessionManager.getSessionByToken(trimmedText);
      if (session) {
        // Update session with this user's info
        session.userId = userId;
        session.dmChannelId = channelId;
        await say(
          `Session configured! You can now:\n` +
          `1. Create a new channel\n` +
          `2. Invite me to the channel\n` +
          `3. I'll start a Claude Code instance for that channel\n\n` +
          `Working directory: \`${session.workingDirectory}\``
        );
      } else {
        await say(`Invalid session token. Please check and try again.`);
      }
      return;
    }

    // Check if user has a session
    const session = this.sessionManager.getSessionByUserId(userId);
    if (!session) {
      await say(
        `Welcome! To get started:\n` +
        `1. Run the minion on your server\n` +
        `2. You'll receive a session token\n` +
        `3. Send me that token here to configure`
      );
      return;
    }

    await say(
      `You're connected! Session token: \`${session.token}\`\n` +
      `Working directory: \`${session.workingDirectory}\`\n\n` +
      `Create a channel and invite me to start a Claude Code instance.`
    );
  }

  private async handleChannelMessage(
    channelId: string,
    userId: string,
    text: string,
    client: any
  ): Promise<void> {
    const channelSession = this.sessionManager.getChannelSession(channelId);
    if (!channelSession) {
      // Check if user has a session and auto-setup
      const session = this.sessionManager.getSessionByUserId(userId);
      if (session) {
        await this.spawnClaudeCodeForChannel(channelId, session.token, userId, client);
        // Wait for setup then send message
        await new Promise(resolve => setTimeout(resolve, 2000));
      } else {
        await client.chat.postMessage({
          channel: channelId,
          text: `Please DM me your session token first to set up Claude Code.`,
        });
        return;
      }
    }

    // Get updated channel session
    const updatedSession = this.sessionManager.getChannelSession(channelId);
    if (!updatedSession) return;

    // Forward message to terminal
    const success = this.terminalManager.sendInput(updatedSession.terminalId, text);
    if (!success) {
      await client.chat.postMessage({
        channel: channelId,
        text: `Claude Code instance not found. Let me restart it...`,
      });
      // Try to respawn
      await this.spawnClaudeCodeForChannel(channelId, updatedSession.sessionToken, userId, client);
    }
  }

  private async spawnClaudeCodeForChannel(
    channelId: string,
    sessionToken: string,
    userId: string,
    client: any
  ): Promise<void> {
    const session = this.sessionManager.getSessionByToken(sessionToken);
    if (!session) {
      console.error('Session not found:', sessionToken);
      return;
    }

    // Create channel session first to get MCP port
    const channelSession = this.sessionManager.createChannelSession(
      channelId,
      sessionToken,
      userId,
      '' // Will update after terminal creation
    );

    try {
      // Spawn Claude Code
      const terminal = await this.terminalManager.spawnClaudeCode(
        channelId,
        channelSession.mcpPort
      );

      // Update channel session with terminal ID
      channelSession.terminalId = terminal.id;

      await client.chat.postMessage({
        channel: channelId,
        text: `Claude Code started! Send a message to interact with it.\n` +
          `Working directory: \`${session.workingDirectory}\``,
      });

      console.log(`Spawned Claude Code for channel ${channelId} on MCP port ${channelSession.mcpPort}`);
    } catch (error) {
      console.error('Failed to spawn Claude Code:', error);
      this.sessionManager.removeChannelSession(channelId);
      await client.chat.postMessage({
        channel: channelId,
        text: `Failed to start Claude Code. Please try again.`,
      });
    }
  }

  // HTTP server to receive messages from MCP servers
  startOrchestratorServer(port: number): void {
    this.orchestratorServer = http.createServer(async (req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405);
        res.end('Method not allowed');
        return;
      }

      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        try {
          const data = JSON.parse(body);
          await this.handleMCPMessage(data);
          res.writeHead(200);
          res.end('OK');
        } catch (error) {
          console.error('Error handling MCP message:', error);
          res.writeHead(500);
          res.end('Error');
        }
      });
    });

    this.orchestratorServer.listen(port, () => {
      console.log(`Orchestrator server listening on port ${port}`);
    });
  }

  private async handleMCPMessage(data: any): Promise<void> {
    const { type, channelId, content, filename, fileContent, mentionText } = data;

    const channelSession = this.sessionManager.getChannelSession(channelId);
    const userId = channelSession?.userId;

    switch (type) {
      case 'markdown':
        await this.app.client.chat.postMessage({
          channel: channelId,
          text: content,
          mrkdwn: true,
        });
        break;

      case 'file':
        await this.app.client.filesUploadV2({
          channel_id: channelId,
          content: fileContent,
          filename: filename,
          title: filename,
        });
        break;

      case 'mention':
        const mention = userId ? `<@${userId}>` : '';
        await this.app.client.chat.postMessage({
          channel: channelId,
          text: `${mention} ${mentionText || content}`,
          mrkdwn: true,
        });
        break;

      case 'action':
        // Notification of action being taken
        await this.app.client.chat.postMessage({
          channel: channelId,
          text: `🔄 ${content}`,
          mrkdwn: true,
        });
        break;

      case 'result':
        // Notification of action result
        await this.app.client.chat.postMessage({
          channel: channelId,
          text: `✅ ${content}`,
          mrkdwn: true,
        });
        break;

      default:
        console.log('Unknown MCP message type:', type);
    }
  }

  async start(): Promise<void> {
    await this.app.start();

    // Get bot user ID
    const authResult = await this.app.client.auth.test();
    this.botUserId = authResult.user_id || '';

    console.log(`⚡️ Slack bot is running! Bot ID: ${this.botUserId}`);
  }

  async stop(): Promise<void> {
    await this.app.stop();
    if (this.orchestratorServer) {
      this.orchestratorServer.close();
    }
  }
}
