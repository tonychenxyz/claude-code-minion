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

interface QueuedMessage {
  input: string;
  resolve: (success: boolean) => void;
}

interface RetryState {
  input: string;
  retryCount: number;
  maxRetries: number;
  resolve: (success: boolean) => void;
}

export class TerminalManager {
  private terminals: Map<string, TerminalInstance> = new Map();
  private outputBuffers: Map<string, string[]> = new Map();
  private workingDirectory: string;
  private appDirectory: string;
  private mcpConfigs: Map<string, string> = new Map(); // channelId -> mcpConfigPath
  private sessionIds: Map<string, string> = new Map(); // channelId -> claude session UUID
  private busyChannels: Set<string> = new Set(); // channels with running claude commands
  private messageQueues: Map<string, QueuedMessage[]> = new Map(); // channelId -> queued messages
  private retryStates: Map<string, RetryState> = new Map(); // channelId -> retry state for session conflicts

  constructor(workingDirectory: string, appDirectory: string) {
    this.workingDirectory = workingDirectory;
    this.appDirectory = appDirectory;
  }

  async spawnClaudeCode(channelId: string, mcpPort: number): Promise<TerminalInstance> {
    const id = uuidv4();

    // Create MCP config for this instance (stored in app directory)
    const mcpConfigDir = path.join(this.appDirectory, '.claude-minion', channelId);
    fs.mkdirSync(mcpConfigDir, { recursive: true });

    const mcpConfigPath = path.join(mcpConfigDir, 'mcp-config.json');
    const mcpConfig = {
      mcpServers: {
        'slack-messenger': {
          command: 'node',
          args: [path.join(this.appDirectory, 'dist', 'mcp-server.js')],
          env: {
            MCP_PORT: mcpPort.toString(),
            CHANNEL_ID: channelId,
            ORCHESTRATOR_URL: `http://localhost:${process.env.ORCHESTRATOR_PORT || 3000}`,
          },
        },
      },
    };
    fs.writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2));

    // Store MCP config path for this channel
    this.mcpConfigs.set(channelId, mcpConfigPath);
    // Generate unique session ID for this channel's Claude conversations
    this.sessionIds.set(channelId, uuidv4());

    // Spawn a shell for running claude commands
    const shell = process.platform === 'win32' ? 'powershell.exe' : 'bash';

    const ptyProcess = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols: 120,
      rows: 40,
      cwd: this.workingDirectory,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
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

      // Detect when Claude command finishes using sentinel marker
      // The marker must appear at the START of a line (after newline) to distinguish
      // from the shell echoing the command itself
      if (this.busyChannels.has(channelId)) {
        // Check for "Session ID is already in use" error and handle with retry
        if (cleanData.includes('is already in use')) {
          const retryState = this.retryStates.get(channelId);
          if (retryState && retryState.retryCount < retryState.maxRetries) {
            // Session conflict - retry with exponential backoff
            const delay = Math.pow(2, retryState.retryCount + 1) * 1000; // 2s, 4s, 8s, 16s
            retryState.retryCount++;
            console.log(`[Terminal ${channelId}] Session conflict detected, retry ${retryState.retryCount}/${retryState.maxRetries} in ${delay}ms...`);
            this.busyChannels.delete(channelId);
            setTimeout(() => {
              this.retryCommand(channelId);
            }, delay);
            return;
          } else if (retryState) {
            // Max retries exceeded - fail and continue with queue
            console.log(`[Terminal ${channelId}] Session conflict: max retries exceeded, generating new session ID`);
            this.sessionIds.set(channelId, uuidv4());
            this.busyChannels.delete(channelId);
            retryState.resolve(false);
            this.retryStates.delete(channelId);
            setTimeout(() => {
              this.processQueue(channelId);
            }, 1000);
            return;
          }
        }

        // Check if marker appears at start of line (real output) vs embedded in command echo
        const lines = cleanData.split('\n');
        for (const line of lines) {
          const trimmedLine = line.trim();
          if (trimmedLine === '___CLAUDE_DONE___') {
            // Command finished - add delay to let Claude release session
            this.busyChannels.delete(channelId);
            // Clear any retry state on success
            this.retryStates.delete(channelId);
            console.log(`[Terminal ${channelId}] Claude command finished, waiting for session release...`);
            setTimeout(() => {
              console.log(`[Terminal ${channelId}] Processing queue after delay...`);
              this.processQueue(channelId);
            }, 2000); // 2 second delay to let Claude release session (increased from 1s)
            break;
          }
        }
      }
    });

    ptyProcess.onExit(({ exitCode }) => {
      console.log(`Terminal ${id} exited with code ${exitCode}`);
      this.terminals.delete(id);
      this.outputBuffers.delete(id);
    });

    // Wait a moment for shell to initialize
    await new Promise(resolve => setTimeout(resolve, 500));

    return terminal;
  }

  // Queue a message to be sent to Claude (handles busy state)
  async sendInput(terminalId: string, input: string): Promise<boolean> {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) {
      console.error(`Terminal ${terminalId} not found`);
      return false;
    }

    const channelId = terminal.channelId;

    // If channel is busy, queue the message
    if (this.busyChannels.has(channelId)) {
      console.log(`[Queue] Channel ${channelId} is busy, queuing message`);
      return new Promise((resolve) => {
        const queue = this.messageQueues.get(channelId) || [];
        queue.push({ input, resolve });
        this.messageQueues.set(channelId, queue);
      });
    }

    // Send immediately
    return this.sendInputNow(terminalId, input);
  }

  // Actually send input to Claude (internal method)
  private sendInputNow(terminalId: string, input: string, existingRetryState?: RetryState): boolean {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) {
      console.error(`Terminal ${terminalId} not found`);
      return false;
    }

    const channelId = terminal.channelId;
    const mcpConfigPath = this.mcpConfigs.get(channelId);
    if (!mcpConfigPath) {
      console.error(`MCP config not found for channel ${channelId}`);
      return false;
    }

    // Escape the input for shell (use double quotes and escape properly)
    const escapedInput = input
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\$/g, '\\$')
      .replace(/`/g, '\\`')
      .replace(/\n/g, ' ')  // Replace newlines with spaces to avoid shell continuation prompts
      .replace(/\r/g, '');  // Remove carriage returns

    // Get session ID for this channel (ensures separate conversations per channel)
    const sessionId = this.sessionIds.get(channelId);
    if (!sessionId) {
      console.error(`Session ID not found for channel ${channelId}`);
      return false;
    }

    // Mark channel as busy
    this.busyChannels.add(channelId);

    // Set up retry state for handling session conflicts
    if (!existingRetryState) {
      // Create new retry state - will be resolved when command completes or fails
      this.retryStates.set(channelId, {
        input,
        retryCount: 0,
        maxRetries: 4,
        resolve: () => {}, // Will be updated by caller if needed
      });
    }

    // Build the claude command with session-id for per-channel conversation isolation
    // Instructions are in CLAUDE.md which claude -p reads automatically
    // Add sentinel marker to detect when command finishes
    const claudeCmd = `claude -p "${escapedInput}" --session-id "${sessionId}" --mcp-config "${mcpConfigPath}" ; echo "___CLAUDE_DONE___"`;

    console.log(`[Sending to Claude] claude -p "..." --session-id "${sessionId}"`);
    terminal.pty.write(claudeCmd + '\r');
    terminal.lastActivity = new Date();
    return true;
  }

  // Retry a command that failed due to session conflict
  private retryCommand(channelId: string): void {
    const retryState = this.retryStates.get(channelId);
    if (!retryState) {
      console.error(`[Retry] No retry state for channel ${channelId}`);
      return;
    }

    const terminal = this.getTerminalByChannelId(channelId);
    if (!terminal) {
      console.error(`[Retry] Terminal not found for channel ${channelId}`);
      retryState.resolve(false);
      this.retryStates.delete(channelId);
      return;
    }

    console.log(`[Retry] Retrying command for channel ${channelId}`);
    this.sendInputNow(terminal.id, retryState.input, retryState);
  }

  // Process next message in the queue for a channel
  private processQueue(channelId: string): void {
    const queue = this.messageQueues.get(channelId);
    if (!queue || queue.length === 0) {
      return;
    }

    const terminal = this.getTerminalByChannelId(channelId);
    if (!terminal) {
      // Clear queue if terminal is gone
      this.messageQueues.delete(channelId);
      return;
    }

    const next = queue.shift()!;
    console.log(`[Queue] Processing next message for channel ${channelId}`);

    const success = this.sendInputNow(terminal.id, next.input);
    next.resolve(success);
  }

  // Check if channel is currently processing a command
  isChannelBusy(channelId: string): boolean {
    return this.busyChannels.has(channelId);
  }

  // Get queue length for a channel
  getQueueLength(channelId: string): number {
    return this.messageQueues.get(channelId)?.length || 0;
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

  // Send interrupt (Ctrl+C) to stop current claude command
  sendInterrupt(terminalId: string): boolean {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) {
      console.error(`Terminal ${terminalId} not found`);
      return false;
    }

    // Send Ctrl+C
    terminal.pty.write('\x03');
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

  // Reset conversation for a channel (generates new session ID)
  resetConversation(channelId: string): void {
    this.sessionIds.set(channelId, uuidv4());
    // Clear busy state and queue
    this.busyChannels.delete(channelId);
    this.messageQueues.delete(channelId);
    console.log(`[Reset] New session ID for channel ${channelId}: ${this.sessionIds.get(channelId)}`);
  }

  // Clear busy state for a channel (call after interrupt)
  clearBusyState(channelId: string): void {
    this.busyChannels.delete(channelId);
    console.log(`[Interrupt] Cleared busy state for channel ${channelId}`);
  }
}
