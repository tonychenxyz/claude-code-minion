#!/usr/bin/env node

import { SlackBot } from './slack-bot.js';
import { SessionManager } from './session-manager.js';
import { TerminalManager } from './terminal-manager.js';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// App directory is where this script lives (app/dist -> app/)
const appDirectory = path.resolve(__dirname, '..');

interface Config {
  slackBotToken: string;
  slackAppToken: string;
  orchestratorPort: number;
  workingDirectory: string;
  appDirectory: string;
}

function loadConfig(): Config {
  // Try to load from .env file in app directory
  const envPath = path.join(appDirectory, '.env');
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf-8');
    for (const line of envContent.split('\n')) {
      const [key, ...valueParts] = line.split('=');
      if (key && valueParts.length > 0) {
        const value = valueParts.join('=').trim().replace(/^["']|["']$/g, '');
        process.env[key.trim()] = value;
      }
    }
  }

  const slackBotToken = process.env.SLACK_BOT_TOKEN;
  const slackAppToken = process.env.SLACK_APP_TOKEN;
  const orchestratorPort = parseInt(process.env.ORCHESTRATOR_PORT || '3000', 10);
  // Default working directory is ../projects relative to app/
  const defaultWorkingDir = path.resolve(appDirectory, '..', 'projects');
  const workingDirectory = process.env.WORKING_DIRECTORY || defaultWorkingDir;

  if (!slackBotToken) {
    console.error('Error: SLACK_BOT_TOKEN is required');
    console.error('Set it in app/.env file or as environment variable');
    process.exit(1);
  }

  if (!slackAppToken) {
    console.error('Error: SLACK_APP_TOKEN is required');
    console.error('Set it in app/.env file or as environment variable');
    process.exit(1);
  }

  return {
    slackBotToken,
    slackAppToken,
    orchestratorPort,
    workingDirectory,
    appDirectory,
  };
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('           Claude Code Minion - Slack Bot');
  console.log('═══════════════════════════════════════════════════════════');

  const config = loadConfig();

  console.log(`App directory: ${config.appDirectory}`);
  console.log(`Working directory: ${config.workingDirectory}`);
  console.log(`Orchestrator port: ${config.orchestratorPort}`);

  // Ensure working directory exists
  if (!fs.existsSync(config.workingDirectory)) {
    fs.mkdirSync(config.workingDirectory, { recursive: true });
    console.log(`Created working directory: ${config.workingDirectory}`);
  }

  // Initialize managers
  const sessionManager = new SessionManager(config.workingDirectory);
  const terminalManager = new TerminalManager(config.workingDirectory, config.appDirectory);

  // Create a session token on startup
  const session = sessionManager.createSession(
    '', // User ID will be set when they DM the bot
    '', // DM channel will be set when they DM the bot
    config.workingDirectory
  );

  console.log('');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  SESSION TOKEN: ' + session.token);
  console.log('═══════════════════════════════════════════════════════════');
  console.log('');
  console.log('To connect:');
  console.log('1. DM the bot in Slack with this token');
  console.log('2. Create a channel and invite the bot');
  console.log('3. Start chatting with Claude Code!');
  console.log('');

  // Initialize Slack bot
  const bot = new SlackBot(
    config.slackBotToken,
    config.slackAppToken,
    config.workingDirectory,
    sessionManager,
    terminalManager
  );

  // Start orchestrator server (receives messages from MCP servers)
  process.env.ORCHESTRATOR_PORT = config.orchestratorPort.toString();
  bot.startOrchestratorServer(config.orchestratorPort);

  // Start the bot
  await bot.start();

  // Handle shutdown
  process.on('SIGINT', async () => {
    console.log('\nShutting down...');
    await bot.stop();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.log('\nShutting down...');
    await bot.stop();
    process.exit(0);
  });
}

main().catch((error) => {
  console.error('Failed to start:', error);
  process.exit(1);
});
