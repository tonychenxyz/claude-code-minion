#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as http from 'http';

// Get configuration from environment
const ORCHESTRATOR_URL = process.env.ORCHESTRATOR_URL || 'http://localhost:3000';
const CHANNEL_ID = process.env.CHANNEL_ID || '';

if (!CHANNEL_ID) {
  console.error('CHANNEL_ID environment variable is required');
  process.exit(1);
}

async function sendToOrchestrator(data: any): Promise<void> {
  return new Promise((resolve, reject) => {
    const url = new URL(ORCHESTRATOR_URL);
    const postData = JSON.stringify({ ...data, channelId: CHANNEL_ID });

    const options: http.RequestOptions = {
      hostname: url.hostname,
      port: url.port || 3000,
      path: '/',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
      },
    };

    const req = http.request(options, (res) => {
      if (res.statusCode === 200) {
        resolve();
      } else {
        reject(new Error(`HTTP ${res.statusCode}`));
      }
    });

    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

async function getFromOrchestrator(path: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const url = new URL(ORCHESTRATOR_URL);

    const options: http.RequestOptions = {
      hostname: url.hostname,
      port: url.port || 3000,
      path: path,
      method: 'GET',
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve({ messages: [] });
        }
      });
    });

    req.on('error', reject);
    req.end();
  });
}

// Create MCP server
const server = new McpServer({
  name: 'slack-messenger',
  version: '1.0.0',
});

// Tool: Get pending messages from Slack
server.tool(
  'get_pending_messages',
  'Check for new messages from the user in Slack. Call this to see if the user has sent any new messages. Returns an array of pending messages.',
  {},
  async () => {
    try {
      const response = await getFromOrchestrator(`/messages/${CHANNEL_ID}`);
      const messages = response.messages || [];

      if (messages.length === 0) {
        return {
          content: [{ type: 'text', text: 'No new messages' }],
        };
      }

      return {
        content: [{
          type: 'text',
          text: `New messages:\n${messages.map((m: any) => `- ${m.user}: ${m.text}`).join('\n')}`
        }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Failed to get messages: ${error}` }],
        isError: true,
      };
    }
  }
);

// Tool: Send markdown message to Slack
server.tool(
  'send_message',
  'Send a markdown-formatted message to the user in Slack. Use this to communicate progress, results, or ask questions.',
  {
    message: z.string().describe('The markdown message to send to Slack'),
  },
  async ({ message }) => {
    try {
      await sendToOrchestrator({
        type: 'markdown',
        content: message,
      });
      return {
        content: [{ type: 'text', text: 'Message sent successfully' }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Failed to send message: ${error}` }],
        isError: true,
      };
    }
  }
);

// Tool: Send file to Slack
server.tool(
  'send_file',
  'Send a file to the user in Slack. Use this to share code files, logs, or other content.',
  {
    filename: z.string().describe('The filename to display in Slack'),
    content: z.string().describe('The file content'),
  },
  async ({ filename, content }) => {
    try {
      await sendToOrchestrator({
        type: 'file',
        filename,
        fileContent: content,
      });
      return {
        content: [{ type: 'text', text: `File "${filename}" sent successfully` }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Failed to send file: ${error}` }],
        isError: true,
      };
    }
  }
);

// Tool: Mention/tag user
server.tool(
  'request_input',
  'Tag/mention the user in Slack to request their input or attention. Use this when you need the user to make a decision or provide information.',
  {
    message: z.string().describe('The message to send along with the mention'),
  },
  async ({ message }) => {
    try {
      await sendToOrchestrator({
        type: 'mention',
        mentionUser: true,
        mentionText: message,
      });
      return {
        content: [{ type: 'text', text: 'User mentioned successfully' }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Failed to mention user: ${error}` }],
        isError: true,
      };
    }
  }
);

// Tool: Notify action being performed
server.tool(
  'notify_action',
  'Notify the user that you are performing an action. Call this BEFORE performing significant operations like editing files, running commands, or making API calls.',
  {
    action: z.string().describe('Description of the action being performed'),
  },
  async ({ action }) => {
    try {
      await sendToOrchestrator({
        type: 'action',
        content: action,
      });
      return {
        content: [{ type: 'text', text: 'Action notification sent' }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Failed to notify: ${error}` }],
        isError: true,
      };
    }
  }
);

// Tool: Notify action result
server.tool(
  'notify_result',
  'Notify the user of an action result. Call this AFTER completing significant operations to report success or failure.',
  {
    result: z.string().describe('Description of the result'),
  },
  async ({ result }) => {
    try {
      await sendToOrchestrator({
        type: 'result',
        content: result,
      });
      return {
        content: [{ type: 'text', text: 'Result notification sent' }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Failed to notify: ${error}` }],
        isError: true,
      };
    }
  }
);

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`Slack Messenger MCP server running for channel ${CHANNEL_ID}`);
}

main().catch((error) => {
  console.error('Failed to start MCP server:', error);
  process.exit(1);
});
