import { promises as fs } from "node:fs";
import path from "node:path";
import { execAsync } from "../../../utils/process/execAsync";

export type CodexRuntimeArtifacts = {
  jsonlPath: string;
  textPath: string;
  stderrPath: string;
  stdoutPath: string;
  usagePath: string;
  cursorPath: string;
  statePath: string;
  jsonlFileName: string;
  textFileName: string;
  stderrFileName: string;
  stdoutFileName: string;
  usageFileName: string;
  cursorFileName: string;
  stateFileName: string;
};

export type CodexRuntimeCursorState = {
  offset: number;
  line: number;
  agentMessageBuffers: Record<string, string>;
};

export const createEmptyCodexRuntimeCursorState = (): CodexRuntimeCursorState => ({
  offset: 0,
  line: 0,
  agentMessageBuffers: {},
});

export const createCodexRuntimeArtifacts = (input: {
  runtimeDir: string;
  jsonlFileName: string;
  textFileName: string;
  stderrFileName: string;
  stdoutFileName: string;
  usageFileName?: string;
}): CodexRuntimeArtifacts => {
  const runtimeBase = input.jsonlFileName.replace(/\.jsonl$/i, "");
  const usageFileName = input.usageFileName || "usage.json";
  return {
    jsonlPath: path.join(input.runtimeDir, input.jsonlFileName),
    textPath: path.join(input.runtimeDir, input.textFileName),
    stderrPath: path.join(input.runtimeDir, input.stderrFileName),
    stdoutPath: path.join(input.runtimeDir, input.stdoutFileName),
    usagePath: path.join(input.runtimeDir, usageFileName),
    cursorPath: path.join(input.runtimeDir, `.${runtimeBase}-cursor.json`),
    statePath: path.join(input.runtimeDir, `.${runtimeBase}-state.json`),
    jsonlFileName: input.jsonlFileName,
    textFileName: input.textFileName,
    stderrFileName: input.stderrFileName,
    stdoutFileName: input.stdoutFileName,
    usageFileName,
    cursorFileName: `.${runtimeBase}-cursor.json`,
    stateFileName: `.${runtimeBase}-state.json`,
  };
};

export const initializeRuntimeFiles = async (input: {
  runtimeDir: string;
  jsonlPath: string;
  textPath: string;
  stderrPath: string;
  stdoutPath: string;
  usagePath?: string;
}) => {
  await fs.mkdir(input.runtimeDir, { recursive: true });
  await Promise.all([
    fs.writeFile(input.jsonlPath, "", "utf-8"),
    fs.writeFile(input.textPath, "", "utf-8"),
    fs.writeFile(input.stderrPath, "", "utf-8"),
    fs.writeFile(input.stdoutPath, "", "utf-8"),
    input.usagePath
      ? fs.writeFile(input.usagePath, "", "utf-8")
      : Promise.resolve(),
  ]);
};

export const initializeCodexRuntimeMetadataFiles = async (input: {
  cursorPath: string;
  statePath: string;
}) => {
  await Promise.all([
    fs.writeFile(
      input.cursorPath,
      JSON.stringify(createEmptyCodexRuntimeCursorState()),
      "utf-8",
    ),
    fs.writeFile(input.statePath, "{}", "utf-8"),
  ]);
};

export const initializeRuntimeFilesInContainer = async (input: {
  containerName: string;
  runtimeDirInContainer: string;
  jsonlFileName: string;
  textFileName: string;
  stderrFileName: string;
  stdoutFileName: string;
  usageFileName?: string;
}) => {
  const usageInit = input.usageFileName
    ? ` && : > '${input.runtimeDirInContainer}/${input.usageFileName}'`
    : "";
  await execAsync(
    `docker exec ${input.containerName} bash -lc "mkdir -p '${input.runtimeDirInContainer}' && : > '${input.runtimeDirInContainer}/${input.jsonlFileName}' && : > '${input.runtimeDirInContainer}/${input.textFileName}' && : > '${input.runtimeDirInContainer}/${input.stderrFileName}' && : > '${input.runtimeDirInContainer}/${input.stdoutFileName}'${usageInit}"`,
  );
};

export const initializeCodexRuntimeMetadataFilesInContainer = async (input: {
  containerName: string;
  runtimeDirInContainer: string;
  cursorFileName: string;
  stateFileName: string;
  writeContainerFile: (containerName: string, filePath: string, content: string) => Promise<void>;
}) => {
  await input.writeContainerFile(
    input.containerName,
    path.posix.join(input.runtimeDirInContainer, input.cursorFileName),
    JSON.stringify(createEmptyCodexRuntimeCursorState()),
  );
  await execAsync(
    `docker exec ${input.containerName} bash -lc "mkdir -p '${input.runtimeDirInContainer}' && : > '${input.runtimeDirInContainer}/${input.stateFileName}'"`,
  );
};
