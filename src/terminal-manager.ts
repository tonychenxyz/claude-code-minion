import * as pty from 'node-pty';
import { v4 as uuidv4 } from 'uuid';
import { TerminalInstance } from './types.js';
import * as path from 'path';
import * as fs from 'fs';

// Dynamic import for strip-ansi (ESM module)
let stripAnsi: (text: string) => string;

async function initStripAnsi() {
  const module = await import('strip-ansi');
  stripAnsi = module.default;
}

initStripAnsi();

export class TerminalManager {
  private terminals: Map<string, TerminalInstance> = new Map();
  private outputBuffers: Map<string, string[]> = new Map();
  private workingDirectory: string;

  constructor(workingDirectory: string) {
    this.workingDirectory = workingDirectory;
  }

  async spawnClaudeCode(channelId: string, mcpPort: number): Promise<TerminalInstance> {
    const id = uuidv4();

    // Create MCP config for this instance
    const mcpConfigDir = path.join(this.workingDirectory, '.claude-minion', channelId);
    fs.mkdirSync(mcpConfigDir, { recursive: true });

    const mcpConfigPath = path.join(mcpConfigDir, 'mcp-config.json');
    const mcpConfig = {
      mcpServers: {
        'slack-messenger': {
          command: 'node',
          args: [path.join(this.workingDirectory, 'dist', 'mcp-server.js')],
          env: {
            MCP_PORT: mcpPort.toString(),
            CHANNEL_ID: channelId,
            ORCHESTRATOR_URL: `http://localhost:${process.env.ORCHESTRATOR_PORT || 3000}`,
          },
        },
      },
    };
    fs.writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2));

    // Spawn Claude Code with the MCP config
    const shell = process.platform === 'win32' ? 'powershell.exe' : 'bash';

    const ptyProcess = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols: 120,
      rows: 40,
      cwd: this.workingDirectory,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        CLAUDE_MCP_CONFIG: mcpConfigPath,
        MCP_PORT: mcpPort.toString(),
        CHANNEL_ID: channelId,
      },
    });

    const terminal: TerminalInstance = {
      id,
      channelId,
      pty: ptyProcess,
      mcpPort,
      lastActivity: new Date(),
    };

    this.terminals.set(id, terminal);
    this.outputBuffers.set(id, []);

    // Collect output and log for debugging
    ptyProcess.onData((data: string) => {
      const buffer = this.outputBuffers.get(id);
      if (buffer) {
        buffer.push(data);
        // Keep only last 1000 lines
        if (buffer.length > 1000) {
          buffer.shift();
        }
      }
      terminal.lastActivity = new Date();
      // Debug: log terminal output
      const cleanData = stripAnsi ? stripAnsi(data) : data;
      if (cleanData.trim()) {
        console.log(`[Terminal ${channelId}] ${cleanData}`);
      }
    });

    ptyProcess.onExit(({ exitCode }) => {
      console.log(`Terminal ${id} exited with code ${exitCode}`);
      this.terminals.delete(id);
      this.outputBuffers.delete(id);
    });

    // Start Claude Code with MCP configuration
    // Wait a moment for shell to initialize
    await new Promise(resolve => setTimeout(resolve, 500));

    // Start claude with the MCP config
    ptyProcess.write(`claude --mcp-config "${mcpConfigPath}"\r`);

    return terminal;
  }

  sendInput(terminalId: string, input: string): boolean {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) {
      console.error(`Terminal ${terminalId} not found`);
      return false;
    }

    // Send the input followed by Enter (newline to submit)
    terminal.pty.write(input + '\n');
    terminal.lastActivity = new Date();
    return true;
  }

  sendRawInput(terminalId: string, input: string): boolean {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) {
      console.error(`Terminal ${terminalId} not found`);
      return false;
    }

    terminal.pty.write(input);
    terminal.lastActivity = new Date();
    return true;
  }

  getOutput(terminalId: string, lines: number = 50): string[] {
    const buffer = this.outputBuffers.get(terminalId);
    if (!buffer) {
      return [];
    }

    const result = buffer.slice(-lines);
    // Strip ANSI codes for cleaner output
    return result.map(line => stripAnsi ? stripAnsi(line) : line);
  }

  getTerminal(terminalId: string): TerminalInstance | undefined {
    return this.terminals.get(terminalId);
  }

  getTerminalByChannelId(channelId: string): TerminalInstance | undefined {
    for (const terminal of this.terminals.values()) {
      if (terminal.channelId === channelId) {
        return terminal;
      }
    }
    return undefined;
  }

  killTerminal(terminalId: string): boolean {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) {
      return false;
    }

    terminal.pty.kill();
    this.terminals.delete(terminalId);
    this.outputBuffers.delete(terminalId);
    return true;
  }

  killByChannelId(channelId: string): boolean {
    const terminal = this.getTerminalByChannelId(channelId);
    if (terminal) {
      return this.killTerminal(terminal.id);
    }
    return false;
  }

  getAllTerminals(): TerminalInstance[] {
    return Array.from(this.terminals.values());
  }

  resize(terminalId: string, cols: number, rows: number): boolean {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) {
      return false;
    }

    terminal.pty.resize(cols, rows);
    return true;
  }
}
