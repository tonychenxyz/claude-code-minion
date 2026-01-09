import { v4 as uuidv4 } from 'uuid';
import { Session, ChannelSession } from './types.js';
import * as fs from 'fs';
import * as path from 'path';

export class SessionManager {
  private sessions: Map<string, Session> = new Map();
  private channelSessions: Map<string, ChannelSession> = new Map();
  private sessionFilePath: string;
  private channelSessionFilePath: string;
  private nextMcpPort: number = 9100;

  constructor(dataDir: string = '.') {
    this.sessionFilePath = path.join(dataDir, '.minion-sessions.json');
    this.channelSessionFilePath = path.join(dataDir, '.minion-channel-sessions.json');
    this.loadSessions();
  }

  private loadSessions(): void {
    try {
      if (fs.existsSync(this.sessionFilePath)) {
        const data = JSON.parse(fs.readFileSync(this.sessionFilePath, 'utf-8'));
        for (const [key, value] of Object.entries(data)) {
          const session = value as Session;
          session.createdAt = new Date(session.createdAt);
          this.sessions.set(key, session);
        }
      }
      if (fs.existsSync(this.channelSessionFilePath)) {
        const data = JSON.parse(fs.readFileSync(this.channelSessionFilePath, 'utf-8'));
        for (const [key, value] of Object.entries(data)) {
          const session = value as ChannelSession;
          session.createdAt = new Date(session.createdAt);
          this.channelSessions.set(key, session);
          // Track highest MCP port
          if (session.mcpPort >= this.nextMcpPort) {
            this.nextMcpPort = session.mcpPort + 1;
          }
        }
      }
    } catch (error) {
      console.error('Error loading sessions:', error);
    }
  }

  private saveSessions(): void {
    try {
      const sessionsObj: Record<string, Session> = {};
      this.sessions.forEach((v, k) => sessionsObj[k] = v);
      fs.writeFileSync(this.sessionFilePath, JSON.stringify(sessionsObj, null, 2));

      const channelSessionsObj: Record<string, ChannelSession> = {};
      this.channelSessions.forEach((v, k) => channelSessionsObj[k] = v);
      fs.writeFileSync(this.channelSessionFilePath, JSON.stringify(channelSessionsObj, null, 2));
    } catch (error) {
      console.error('Error saving sessions:', error);
    }
  }

  createSession(userId: string, dmChannelId: string, workingDirectory: string): Session {
    const token = uuidv4().substring(0, 8).toUpperCase();
    const session: Session = {
      token,
      userId,
      dmChannelId,
      createdAt: new Date(),
      workingDirectory,
    };
    this.sessions.set(token, session);
    this.saveSessions();
    return session;
  }

  getSessionByToken(token: string): Session | undefined {
    return this.sessions.get(token.toUpperCase());
  }

  getSessionByUserId(userId: string): Session | undefined {
    for (const session of this.sessions.values()) {
      if (session.userId === userId) {
        return session;
      }
    }
    return undefined;
  }

  updateSessionUser(token: string, userId: string, dmChannelId: string): boolean {
    const session = this.sessions.get(token.toUpperCase());
    if (session) {
      session.userId = userId;
      session.dmChannelId = dmChannelId;
      this.saveSessions();
      return true;
    }
    return false;
  }

  createChannelSession(
    channelId: string,
    sessionToken: string,
    userId: string,
    terminalId: string
  ): ChannelSession {
    const mcpPort = this.nextMcpPort++;
    const channelSession: ChannelSession = {
      channelId,
      sessionToken,
      userId,
      terminalId,
      mcpPort,
      createdAt: new Date(),
    };
    this.channelSessions.set(channelId, channelSession);
    this.saveSessions();
    return channelSession;
  }

  getChannelSession(channelId: string): ChannelSession | undefined {
    return this.channelSessions.get(channelId);
  }

  removeChannelSession(channelId: string): void {
    this.channelSessions.delete(channelId);
    this.saveSessions();
  }

  getAllChannelSessions(): ChannelSession[] {
    return Array.from(this.channelSessions.values());
  }

  getChannelIdByMcpPort(port: number): string | undefined {
    for (const session of this.channelSessions.values()) {
      if (session.mcpPort === port) {
        return session.channelId;
      }
    }
    return undefined;
  }

  getUserIdByChannelId(channelId: string): string | undefined {
    const session = this.channelSessions.get(channelId);
    return session?.userId;
  }
}
