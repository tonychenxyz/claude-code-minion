export interface Session {
  token: string;
  userId: string;
  dmChannelId: string;
  createdAt: Date;
  workingDirectory: string;
}

export interface ChannelSession {
  channelId: string;
  sessionToken: string;
  userId: string;
  terminalId: string;
  mcpPort: number;
  createdAt: Date;
}

export interface TerminalInstance {
  id: string;
  channelId: string;
  pty: any; // node-pty IPty
  mcpPort: number;
  lastActivity: Date;
}

export interface MCPMessage {
  type: 'markdown' | 'file' | 'mention';
  channelId: string;
  content?: string;
  filename?: string;
  fileContent?: string;
  mentionUser?: boolean;
  mentionText?: string;
}
