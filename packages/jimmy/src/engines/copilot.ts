import { spawn, type ChildProcess } from "node:child_process";
import type { InterruptibleEngine, EngineRunOpts, EngineResult, StreamDelta } from "../shared/types.js";
import { logger } from "../shared/logger.js";

interface LiveProcess {
  proc: ChildProcess;
  terminationReason: string | null;
}

export class CopilotEngine implements InterruptibleEngine {
  name = "copilot" as const;
  private liveProcesses = new Map<string, LiveProcess>();

  kill(sessionId: string, reason = "Interrupted"): void {
    const live = this.liveProcesses.get(sessionId);
    if (!live) return;

    live.terminationReason = reason;
    logger.info(`Killing Copilot process for session ${sessionId}`);
    this.signalProcess(live.proc, "SIGTERM");
    setTimeout(() => {
      if (live.proc.exitCode === null) {
        this.signalProcess(live.proc, "SIGKILL");
      }
    }, 2000);
  }

  killAll(): void {
    for (const sessionId of this.liveProcesses.keys()) {
      this.kill(sessionId, "Interrupted: gateway shutting down");
    }
  }

  isAlive(sessionId: string): boolean {
    const live = this.liveProcesses.get(sessionId);
    return !!live && !live.proc.killed && live.proc.exitCode === null;
  }

  async run(opts: EngineRunOpts): Promise<EngineResult> {
    let prompt = opts.prompt;
    if (opts.systemPrompt) {
      prompt = opts.systemPrompt + "\n\n---\n\n" + prompt;
    }
    if (opts.attachments?.length) {
      prompt += "\n\nAttached files:\n" + opts.attachments.map((a) => `- ${a}`).join("\n");
    }

    const bin = opts.bin || "copilot";
    const isResume = !!opts.resumeSessionId;
    const args = isResume
      ? this.buildResumeArgs(opts, prompt)
      : this.buildFreshArgs(opts, prompt);

    logger.info(
      `Copilot engine starting: ${bin} ${args[0]}${isResume ? " resume" : ""} --model ${opts.model || "default"} (resume: ${opts.resumeSessionId || "none"})`,
    );

    const cleanEnv = this.buildCleanEnv();

    return new Promise((resolve, reject) => {
      const proc = spawn(bin, args, {
        cwd: opts.cwd,
        env: cleanEnv,
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });

      const sessionId = opts.sessionId || `copilot-${Date.now()}`;
      this.liveProcesses.set(sessionId, {
        proc,
        terminationReason: null,
      });

      let stderr = "";
      let settled = false;
      let threadId = "";
      let resultText = "";
      let numTurns = 0;
      let turnError: string | null = null;
      let lineBuf = "";
      const onStream = opts.onStream || null;
      const STDERR_MAX = 10 * 1024; // 10KB rolling window for error reporting

      proc.stdout.on("data", (d: Buffer) => {
        lineBuf += d.toString();
        const lines = lineBuf.split("\n");
        lineBuf = lines.pop() || "";
        for (const line of lines) {
          const parsed = this.processJsonlLine(line);
          if (!parsed) continue;

          switch (parsed.type) {
            case "session_id":
              threadId = parsed.sessionId;
              logger.info(`Copilot session got ID: ${threadId}`);
              break;
            case "tool_start":
              if (onStream) onStream(parsed.delta);
              break;
            case "tool_end":
              if (onStream) onStream(parsed.delta);
              break;
            case "text":
              resultText += parsed.delta.content;
              if (onStream) onStream(parsed.delta);
              break;
            case "error":
              turnError = parsed.message;
              if (onStream) onStream({ type: "error", content: parsed.message });
              break;
            case "usage":
              numTurns++;
              break;
            case "turn_failed":
              turnError = parsed.message;
              if (onStream) onStream({ type: "error", content: parsed.message });
              break;
          }
        }
      });

      proc.stderr.on("data", (d: Buffer) => {
        const chunk = d.toString();
        stderr += chunk;
        // Keep only the last 10KB of stderr to bound memory usage
        if (stderr.length > STDERR_MAX) {
          stderr = stderr.slice(stderr.length - STDERR_MAX);
        }
        for (const line of chunk.trim().split("\n").filter(Boolean)) {
          logger.debug(`[copilot stderr] ${line}`);
        }
      });

      proc.stdin.end();

      proc.on("close", (code) => {
        if (settled) return;
        settled = true;

        const terminationReason = this.liveProcesses.get(sessionId)?.terminationReason ?? null;
        this.liveProcesses.delete(sessionId);

        if (lineBuf.trim()) {
          const parsed = this.processJsonlLine(lineBuf);
          if (parsed) {
            switch (parsed.type) {
              case "session_id":
                threadId = parsed.sessionId;
                break;
              case "text":
                resultText += parsed.delta.content;
                break;
              case "usage":
                numTurns++;
                break;
              case "error":
                turnError = parsed.message;
                break;
              case "turn_failed":
                turnError = parsed.message;
                break;
            }
          }
        }

        logger.info(`Copilot engine exited with code ${code} (session: ${threadId || "none"}, turns: ${numTurns})`);

        if (terminationReason) {
          resolve({
            sessionId: threadId || opts.resumeSessionId || "",
            result: resultText,
            error: terminationReason,
            numTurns: numTurns || undefined,
          });
          return;
        }

        if (code === 0 || (code !== null && threadId)) {
          resolve({
            sessionId: threadId || opts.resumeSessionId || "",
            result: resultText,
            error: turnError ?? undefined,
            numTurns: numTurns || undefined,
          });
          return;
        }

        const errMsg = turnError || `Copilot exited with code ${code}: ${stderr.slice(0, 500)}`;
        logger.error(errMsg);
        resolve({
          sessionId: threadId || opts.resumeSessionId || "",
          result: resultText,
          error: errMsg,
        });
      });

      proc.on("error", (err) => {
        if (settled) return;
        settled = true;
        this.liveProcesses.delete(sessionId);
        reject(new Error(`Failed to spawn Copilot CLI: ${err.message}`));
      });
    });
  }

  private buildFreshArgs(opts: EngineRunOpts, prompt: string): string[] {
    const args = ["exec"];
    if (opts.model) args.push("--model", opts.model);
    if (opts.effortLevel && opts.effortLevel !== "default") args.push("-c", `model_reasoning_effort="${opts.effortLevel}"`);
    args.push("--json", "--color", "never");
    if (opts.cwd) args.push("-C", opts.cwd);
    if (opts.cliFlags?.length) args.push(...opts.cliFlags);
    args.push(prompt);
    return args;
  }

  private buildResumeArgs(opts: EngineRunOpts, prompt: string): string[] {
    const args = ["exec", "resume"];
    if (opts.model) args.push("--model", opts.model);
    if (opts.effortLevel && opts.effortLevel !== "default") args.push("-c", `model_reasoning_effort="${opts.effortLevel}"`);
    args.push("--json");
    if (opts.cliFlags?.length) args.push(...opts.cliFlags);
    args.push(opts.resumeSessionId!);
    args.push(prompt);
    return args;
  }

  private processJsonlLine(
    line: string,
  ):
    | { type: "session_id"; sessionId: string }
    | { type: "tool_start"; delta: StreamDelta }
    | { type: "tool_end"; delta: StreamDelta }
    | { type: "text"; delta: StreamDelta }
    | { type: "error"; message: string }
    | { type: "usage" }
    | { type: "turn_failed"; message: string }
    | null {
    const trimmed = line.trim();
    if (!trimmed) return null;

    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      logger.debug(`[copilot stream] unparseable line: ${trimmed.slice(0, 100)}`);
      return null;
    }

    const eventType = String(msg.type || "");

    // Session started — capture the session/thread ID
    if (eventType === "session.started" || eventType === "thread.started") {
      return { type: "session_id", sessionId: String(msg.session_id || msg.thread_id || "") };
    }

    // Tool invocation started
    if (eventType === "item.started") {
      const item = msg.item as Record<string, unknown> | undefined;
      if (!item) return null;
      const itemType = String(item.type || "");

      if (itemType === "command_execution") {
        const command = String(item.command || "shell");
        return {
          type: "tool_start",
          delta: {
            type: "tool_use",
            content: `Running: ${command}`,
            toolName: "command_execution",
            toolId: String(item.id || ""),
          },
        };
      }

      if (itemType === "file_edit") {
        const filePath = String(item.file_path || item.filename || "file");
        return {
          type: "tool_start",
          delta: {
            type: "tool_use",
            content: `Editing: ${filePath}`,
            toolName: "file_edit",
            toolId: String(item.id || ""),
          },
        };
      }

      if (itemType === "file_read") {
        const filePath = String(item.file_path || item.filename || "file");
        return {
          type: "tool_start",
          delta: {
            type: "tool_use",
            content: `Reading: ${filePath}`,
            toolName: "file_read",
            toolId: String(item.id || ""),
          },
        };
      }

      return null;
    }

    // Tool invocation completed or agent message
    if (eventType === "item.completed") {
      const item = msg.item as Record<string, unknown> | undefined;
      if (!item) return null;
      const itemType = String(item.type || "");

      if (itemType === "agent_message") {
        const text = String(item.text || "");
        if (text) {
          return { type: "text", delta: { type: "text", content: text } };
        }
      }

      if (itemType === "command_execution") {
        const output = String(item.aggregated_output || "");
        const exitCode = item.exit_code;
        const command = String(item.command || "shell");
        return {
          type: "tool_end",
          delta: {
            type: "tool_result",
            content: output
              ? `${command} (exit ${exitCode}): ${output.slice(0, 500)}`
              : `${command} (exit ${exitCode})`,
          },
        };
      }

      if (itemType === "file_edit") {
        const filePath = String(item.file_path || item.filename || "file");
        return { type: "tool_end", delta: { type: "tool_result", content: `Edited: ${filePath}` } };
      }

      if (itemType === "file_read") {
        const filePath = String(item.file_path || item.filename || "file");
        return { type: "tool_end", delta: { type: "tool_result", content: `Read: ${filePath}` } };
      }

      if (itemType === "error") {
        const message = String(item.message || "Unknown error");
        return { type: "error", message };
      }

      return null;
    }

    // Assistant message delta (streaming text)
    if (eventType === "assistant.message_delta") {
      const content = String(msg.delta_content || msg.deltaContent || "");
      if (content) {
        return { type: "text", delta: { type: "text", content } };
      }
      return null;
    }

    // Turn completed
    if (eventType === "turn.completed") {
      return { type: "usage" };
    }

    // Turn failed
    if (eventType === "turn.failed") {
      const error = msg.error as Record<string, unknown> | undefined;
      return { type: "turn_failed", message: String(error?.message || "Turn failed") };
    }

    // Generic error
    if (eventType === "error") {
      return { type: "error", message: String(msg.message || "Unknown error") };
    }

    return null;
  }

  private buildCleanEnv(): Record<string, string> {
    const cleanEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_")) continue;
      if (k === "CODEX" || k.startsWith("CODEX_")) continue;
      if (v !== undefined) cleanEnv[k] = v;
    }
    return cleanEnv;
  }

  private signalProcess(proc: ChildProcess, signal: NodeJS.Signals): void {
    if (proc.exitCode !== null) return;
    try {
      if (process.platform !== "win32" && proc.pid) {
        process.kill(-proc.pid, signal);
      } else {
        proc.kill(signal);
      }
    } catch (err) {
      logger.debug(`Failed to send ${signal} to Copilot process: ${err instanceof Error ? err.message : err}`);
    }
  }
}
