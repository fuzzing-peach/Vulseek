// @ts-nocheck
import { createIncrementalParser as createClaudeCodeParser } from "./formats/claude-code.mjs";
import { createIncrementalParser as createCodexParser } from "./formats/codex.mjs";

const SUPPORTED_FORMATS = new Set(["codex", "claude-code"]);

const cloneTurns = (turns) => JSON.parse(JSON.stringify(turns));

const firstChangedTurn = (previous, next) => {
  const limit = Math.min(previous.length, next.length);
  for (let index = 0; index < limit; index++) {
    if (JSON.stringify(previous[index]) !== JSON.stringify(next[index])) {
      return index;
    }
  }
  return limit;
};

/**
 * Parse native Codex or Claude Code JSONL as chunks arrive.
 *
 * The existing format parsers remain the source of truth for transcript
 * semantics. This wrapper adds stream framing and a stable changedFrom index
 * for incremental consumers such as React.
 */
export function createAgentStreamParser({ format }) {
  if (!SUPPORTED_FORMATS.has(format)) {
    throw new Error(`Unsupported agent stream format: ${format}`);
  }

  const state = format === "codex" ? createCodexParser() : createClaudeCodeParser();
  let pendingLine = "";
  let turns = [];
  let warningCount = 0;

  const result = (nextTurns, changedFrom = firstChangedTurn(turns, nextTurns)) => {
    turns = cloneTurns(nextTurns);
    return {
      turns: cloneTurns(turns),
      changedFrom,
      warningCount,
    };
  };

  const processLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      state.push(JSON.parse(trimmed));
    } catch {
      warningCount += 1;
    }
  };

  return {
    push(chunk) {
      if (typeof chunk !== "string" || chunk.length === 0) {
        return result(turns, turns.length);
      }

      pendingLine += chunk;
      const lines = pendingLine.split("\n");
      pendingLine = lines.pop() ?? "";
      if (lines.length === 0) {
        return result(turns, turns.length);
      }
      for (const line of lines) processLine(line);
      return result(state.snapshot());
    },

    reset() {
      pendingLine = "";
      warningCount = 0;
      state.reset();
      return result([], 0);
    },

    finish() {
      if (pendingLine) {
        processLine(pendingLine);
        pendingLine = "";
      }
      return result(state.snapshot());
    },
  };
}
