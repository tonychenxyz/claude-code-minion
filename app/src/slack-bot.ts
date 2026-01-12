import pkg from '@slack/bolt';
const { App, LogLevel } = pkg;
import { SessionManager } from './session-manager.js';
import { TerminalManager } from './terminal-manager.js';
import * as http from 'http';
import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';

interface PendingMessage {
  user: string;
  text: string;
  timestamp: Date;
  files?: string[]; // Paths to downloaded files
}

interface SlackFile {
  id: string;
  name: string;
  url_private_download?: string;
  url_private?: string;
}

export class SlackBot {
  private app: InstanceType<typeof App>;
  private sessionManager: SessionManager;
  private terminalManager: TerminalManager;
  private orchestratorServer: http.Server | null = null;
  private botUserId: string = '';
  private workingDirectory: string;
  private appDirectory: string;

  // Message queue per channel - Claude pulls from this via MCP
  private messageQueues: Map<string, PendingMessage[]> = new Map();

  constructor(
    botToken: string,
    appToken: string,
    workingDirectory: string,
    appDirectory: string,
    sessionManager: SessionManager,
    terminalManager: TerminalManager
  ) {
    this.workingDirectory = workingDirectory;
    this.appDirectory = appDirectory;
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
      // Process any attached files
      const downloadedFiles = await this.processMessageFiles(message, channelId);
      await this.handleChannelMessage(channelId, userId, text, client, downloadedFiles);
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

      // Process any attached files
      const downloadedFiles = await this.processMessageFiles(event, channelId);
      await this.handleChannelMessage(channelId, userId, text, client, downloadedFiles);
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
        // Update session with this user's info and persist
        this.sessionManager.updateSessionUser(trimmedText, userId, channelId);
        await say(
          `✅ Session configured! You can now:\n` +
          `1. Create a new channel\n` +
          `2. Invite me to the channel\n` +
          `3. I'll start a Claude Code instance for that channel\n\n` +
          `Working directory: \`${session.workingDirectory}\``
        );
      } else {
        await say(`❌ Invalid session token \`${trimmedText}\`. Please check and try again.\n\nThe token should be 8 characters like \`A1B2C3D4\` - shown in the terminal when you run \`npm start\`.`);
      }
      return;
    }

    // Check if user has a session
    const session = this.sessionManager.getSessionByUserId(userId);
    if (!session) {
      await say(
        `Welcome! To get started:\n` +
        `1. Run \`npm start\` on your server\n` +
        `2. Copy the *SESSION TOKEN* shown (8 characters like \`A1B2C3D4\`)\n` +
        `3. Send me that token here\n\n` +
        `⚠️ Note: Send the session token, not your Slack user ID!`
      );
      return;
    }

    await say(
      `✅ You're connected! Session token: \`${session.token}\`\n` +
      `Working directory: \`${session.workingDirectory}\`\n\n` +
      `Create a channel and invite me to start a Claude Code instance.`
    );
  }

  private async handleChannelMessage(
    channelId: string,
    userId: string,
    text: string,
    client: any,
    files: string[] = []
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

    // Check for special commands
    const trimmedText = text.trim().toLowerCase();

    // Interrupt command
    if (trimmedText === '!interrupt' || trimmedText === '!stop' || trimmedText === '!esc') {
      const success = this.terminalManager.sendInterrupt(updatedSession.terminalId);
      // Clear busy state so next message can be processed
      this.terminalManager.clearBusyState(channelId);
      if (success) {
        await client.chat.postMessage({
          channel: channelId,
          text: `⏹️ Interrupted Claude Code (sent Ctrl+C)`,
        });
      } else {
        await client.chat.postMessage({
          channel: channelId,
          text: `Failed to interrupt - terminal not found`,
        });
      }
      return;
    }

    // Reset command - start fresh conversation
    if (trimmedText === '!reset' || trimmedText === '!new') {
      this.terminalManager.resetConversation(channelId);
      // Clear message queue
      this.messageQueues.set(channelId, []);
      await client.chat.postMessage({
        channel: channelId,
        text: `🔄 Conversation reset. Next message will start a new Claude Code session.`,
      });
      return;
    }

    // Debug command - show terminal output
    if (trimmedText === '!debug' || trimmedText === '!output') {
      const output = this.terminalManager.getOutput(updatedSession.terminalId, 30);
      const outputText = output.join('').slice(-3000); // Last 3000 chars
      await client.chat.postMessage({
        channel: channelId,
        text: `📟 Terminal output (last 30 chunks):\n\`\`\`\n${outputText || '(no output)'}\n\`\`\``,
      });
      return;
    }

    // Help command - show available commands
    if (trimmedText === '!help') {
      await client.chat.postMessage({
        channel: channelId,
        text: `📖 *Available Commands:*\n` +
          `• \`!interrupt\` / \`!stop\` / \`!esc\` - Interrupt current Claude operation\n` +
          `• \`!reset\` / \`!new\` - Start a new conversation\n` +
          `• \`!debug\` / \`!output\` - Show terminal output\n` +
          `• \`!help\` - Show this help message`,
      });
      return;
    }

    // Build message with file info if files were attached
    let messageWithFiles = text;
    if (files.length > 0) {
      const fileList = files.map(f => `  - ${f}`).join('\n');
      messageWithFiles = `${text}\n\n[Attached files saved to:\n${fileList}]`;
    }

    // Queue the message and trigger Claude to check
    this.queueMessage(channelId, userId, messageWithFiles);

    // Check if Claude is busy and notify user
    if (this.terminalManager.isChannelBusy(channelId)) {
      const queuePos = this.terminalManager.getQueueLength(channelId) + 1;
      await client.chat.postMessage({
        channel: channelId,
        text: `⏳ Claude is busy. Your message is queued (position ${queuePos}).`,
      });
    }

    // Trigger Claude to process the message (will queue if busy)
    const success = await this.terminalManager.sendInput(updatedSession.terminalId, messageWithFiles);
    if (!success) {
      await client.chat.postMessage({
        channel: channelId,
        text: `Claude Code instance not found. Let me restart it...`,
      });
      // Try to respawn
      await this.spawnClaudeCodeForChannel(channelId, updatedSession.sessionToken, userId, client);
    }
  }

  private queueMessage(channelId: string, userId: string, text: string): void {
    if (!this.messageQueues.has(channelId)) {
      this.messageQueues.set(channelId, []);
    }

    const queue = this.messageQueues.get(channelId)!;
    queue.push({
      user: userId,
      text: text,
      timestamp: new Date(),
    });

    // Keep only last 100 messages
    if (queue.length > 100) {
      queue.shift();
    }
  }

  // Get and clear pending messages for a channel
  getPendingMessages(channelId: string): PendingMessage[] {
    const messages = this.messageQueues.get(channelId) || [];
    // Clear the queue after reading
    this.messageQueues.set(channelId, []);
    return messages;
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

  // HTTP server to receive messages from MCP servers and serve pending messages
  startOrchestratorServer(port: number): void {
    this.orchestratorServer = http.createServer(async (req, res) => {
      const url = new URL(req.url || '/', `http://localhost:${port}`);

      // GET /messages/:channelId - MCP server fetches pending messages
      if (req.method === 'GET' && url.pathname.startsWith('/messages/')) {
        const channelId = url.pathname.split('/messages/')[1];
        const messages = this.getPendingMessages(channelId);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ messages }));
        return;
      }

      // POST / - MCP server sends messages to Slack
      if (req.method === 'POST') {
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
        return;
      }

      res.writeHead(404);
      res.end('Not found');
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

  // Download a file from Slack and save to tmp directory
  private async downloadSlackFile(file: SlackFile, channelId: string): Promise<string | null> {
    const url = file.url_private_download || file.url_private;
    if (!url) {
      console.error('No download URL for file:', file.name);
      return null;
    }

    // Create tmp directory for this channel (stored in app directory)
    const tmpDir = path.join(this.appDirectory, '.claude-minion', 'tmp', channelId);
    fs.mkdirSync(tmpDir, { recursive: true });

    // Generate unique filename with timestamp
    const timestamp = Date.now();
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
    const filePath = path.join(tmpDir, `${timestamp}-${safeName}`);

    const token = this.app.client.token;

    // Helper to download from a URL
    const downloadFromUrl = (downloadUrl: string): Promise<string | null> => {
      return new Promise((resolve) => {
        const request = https.get(downloadUrl, {
          headers: {
            'Authorization': `Bearer ${token}`,
          },
        }, (response) => {
          // Handle redirects
          if (response.statusCode === 302 || response.statusCode === 301) {
            const redirectUrl = response.headers.location;
            if (redirectUrl) {
              // Recursively follow redirect
              downloadFromUrl(redirectUrl).then(resolve);
            } else {
              console.error('Redirect without location header');
              resolve(null);
            }
            return;
          }

          if (response.statusCode !== 200) {
            console.error(`Failed to download file: HTTP ${response.statusCode}`);
            resolve(null);
            return;
          }

          // Collect all data chunks
          const chunks: Buffer[] = [];

          response.on('data', (chunk: Buffer) => {
            chunks.push(chunk);
          });

          response.on('end', () => {
            try {
              const buffer = Buffer.concat(chunks);
              fs.writeFileSync(filePath, buffer);
              const sizeMB = (buffer.length / 1024 / 1024).toFixed(2);
              console.log(`Downloaded file: ${filePath} (${sizeMB} MB)`);
              resolve(filePath);
            } catch (err) {
              console.error('Error writing file:', err);
              resolve(null);
            }
          });

          response.on('error', (err) => {
            console.error('Error reading response:', err);
            resolve(null);
          });
        });

        request.on('error', (err) => {
          console.error('Error downloading file:', err);
          resolve(null);
        });
      });
    };

    return downloadFromUrl(url);
  }

  // Process files attached to a message
  private async processMessageFiles(message: any, channelId: string): Promise<string[]> {
    const downloadedFiles: string[] = [];

    if (message.files && Array.isArray(message.files)) {
      for (const file of message.files as SlackFile[]) {
        const filePath = await this.downloadSlackFile(file, channelId);
        if (filePath) {
          downloadedFiles.push(filePath);
        }
      }
    }

    return downloadedFiles;
  }
}
