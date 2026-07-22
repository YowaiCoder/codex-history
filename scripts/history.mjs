#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { parseArgs } from "node:util";

const UUID_PATTERN = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})[.]jsonl$/i;
const DEFAULT_SEARCH_RESULTS = 20;
const DEFAULT_CONTEXT_COUNT = 2;
const DEFAULT_STDOUT_MESSAGES = 200;
const DEFAULT_STDOUT_CHARACTERS = 100_000;

const HELP = `Usage: history.mjs <command> [options]

Commands:
  catalog                Render a Markdown directory of conversations (default)
  read                   Render original conversation events
  search <text>          Search conversation messages
  doctor                 Resolve and inspect the selected conversation

Conversation selection:
  --thread <id-or-name>  Select a thread by UUID, UUID prefix, or indexed name
  --path <jsonl>         Read an explicit rollout JSONL file
  --codex-home <path>    Override CODEX_HOME or ~/.codex

Rendering and filtering:
  --time                  Add short local timestamps (MM-DD HH:mm)
  --thinking              Include visible thinking summaries
  --final-only            Hide thinking and assistant commentary
  --no-compactions        Hide compaction boundary markers
  --clean-context         Hide known injected context-only user messages
  --role <roles>          Comma-separated: user,assistant,thinking
  --phase <phases>        Comma-separated: commentary,final
  --from <time>           Include events at or after an ISO/local timestamp
  --to <time>             Include events at or before an ISO/local timestamp
  --max-messages <n>      Limit rendered events
  --max-chars <n>         Limit rendered characters
  --output <path>         Write output instead of stdout

Read:
  -n, --tail <n>          Render only the most recent n visible events

Search:
  --regex                 Interpret the query as a regular expression
  --case-sensitive        Use case-sensitive matching
  --before <n>            Context events before each match (default: 2)
  --after <n>             Context events after each match (default: 2)
  --max-results <n>       Maximum matches (default: 20)
  --offset <n>            Skip the first n matches
  --order <order>         newest (default) or oldest

Catalog:
  --scope <scope>         active (default), archived, or all
  --projects              Summarize projects instead of conversations
  --project <query>       Filter by project name or path
  --flat                  Do not group conversations under project headings
  --limit <n>             Limit listed conversations

Examples:
  node history.mjs catalog
  node history.mjs catalog --scope all --project SwiftWM
  node history.mjs read --tail 20
  node history.mjs search "Godot delay" --before 4 --after 6
  node history.mjs search "focus.*overlay" --regex --role user
  node history.mjs read --thread 019f8a35 --output transcript.txt
`;

const optionSpec = {
  help: { type: "boolean", short: "h" },
  thread: { type: "string" },
  path: { type: "string" },
  "codex-home": { type: "string" },
  time: { type: "boolean" },
  thinking: { type: "boolean" },
  "final-only": { type: "boolean" },
  "no-compactions": { type: "boolean" },
  "clean-context": { type: "boolean" },
  role: { type: "string", multiple: true },
  phase: { type: "string", multiple: true },
  from: { type: "string" },
  to: { type: "string" },
  "max-messages": { type: "string" },
  "max-chars": { type: "string" },
  output: { type: "string" },
  tail: { type: "string", short: "n" },
  regex: { type: "boolean" },
  "case-sensitive": { type: "boolean" },
  before: { type: "string" },
  after: { type: "string" },
  "max-results": { type: "string" },
  offset: { type: "string" },
  order: { type: "string" },
  scope: { type: "string" },
  projects: { type: "boolean" },
  project: { type: "string" },
  flat: { type: "boolean" },
  limit: { type: "string" },
};

class UsageError extends Error {}

const fail = (message, exitCode = 1) => {
  console.error(message);
  process.exit(exitCode);
};

const integerOption = (value, name, fallback, { minimum = 0 } = {}) => {
  if (value === undefined) return fallback;
  if (!/^[0-9]+$/.test(value)) throw new UsageError(`${name} must be an integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new UsageError(`${name} must be at least ${minimum}`);
  }
  return parsed;
};

const splitValues = (values) => new Set(
  (values || []).flatMap((value) => value.split(",")).map((value) => value.trim().toLowerCase()).filter(Boolean),
);

const parseTime = (value, name) => {
  if (value === undefined) return null;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new UsageError(`Invalid ${name} timestamp: ${value}`);
  return time;
};

let parsed;
try {
  parsed = parseArgs({ args: process.argv.slice(2), options: optionSpec, allowPositionals: true, strict: true });
} catch (error) {
  fail(`${error.message}\n\n${HELP}`);
}

const { values, positionals } = parsed;
if (values.help) {
  console.log(HELP);
  process.exit(0);
}

const command = positionals.shift() || "catalog";
const supportedCommands = new Set(["catalog", "read", "search", "doctor"]);
if (!supportedCommands.has(command)) fail(`Unknown command: ${command}\n\n${HELP}`);

const codexHome = path.resolve(values["codex-home"] || process.env.CODEX_HOME || path.join(os.homedir(), ".codex"));

const walkJsonl = (root, archived) => {
  if (!fs.existsSync(root)) return [];
  const results = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(file);
      else if (entry.isFile()) {
        const match = entry.name.match(UUID_PATTERN);
        if (match) results.push({ id: match[1].toLowerCase(), file, archived, stat: fs.statSync(file) });
      }
    }
  }
  return results;
};

const allSessionFiles = () => [
  ...walkJsonl(path.join(codexHome, "sessions"), false),
  ...walkJsonl(path.join(codexHome, "archived_sessions"), true),
];

const readIndex = () => {
  const indexPath = path.join(codexHome, "session_index.jsonl");
  const records = new Map();
  if (!fs.existsSync(indexPath)) return records;
  for (const line of fs.readFileSync(indexPath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      if (!record.id) continue;
      const previous = records.get(record.id);
      if (!previous || String(previous.updated_at || "") <= String(record.updated_at || "")) {
        records.set(record.id, record);
      }
    } catch {
      // Keep one malformed index entry from blocking access to the rollout files.
    }
  }
  return records;
};

const resolveThreadID = (query, files, index) => {
  if (!query) return null;
  const normalized = query.toLowerCase();
  const exactFile = files.find(({ id }) => id === normalized);
  if (exactFile) return exactFile.id;

  const idMatches = [...new Set(files.map(({ id }) => id).filter((id) => id.startsWith(normalized)))];
  if (idMatches.length === 1) return idMatches[0];
  if (idMatches.length > 1) throw new UsageError(`Thread ID prefix is ambiguous: ${query}`);

  const exactNames = [...index.values()].filter(
    (record) => String(record.thread_name || "").toLowerCase() === normalized && files.some(({ id }) => id === record.id),
  );
  if (exactNames.length === 1) return exactNames[0].id;
  if (exactNames.length > 1) throw new UsageError(`Thread name is ambiguous: ${query}`);

  const nameMatches = [...index.values()].filter(
    (record) => String(record.thread_name || "").toLowerCase().includes(normalized) && files.some(({ id }) => id === record.id),
  );
  if (nameMatches.length === 1) return nameMatches[0].id;
  if (nameMatches.length > 1) throw new UsageError(`Thread name matches multiple conversations: ${query}`);
  throw new UsageError(`Thread not found: ${query}`);
};

const resolveSession = () => {
  if (values.path) {
    const explicit = path.resolve(values.path);
    if (!fs.existsSync(explicit)) throw new UsageError(`Session file not found: ${explicit}`);
    return { id: explicit.match(UUID_PATTERN)?.[1] || "(explicit path)", file: explicit, archived: false, stat: fs.statSync(explicit) };
  }

  const files = allSessionFiles();
  if (files.length === 0) throw new UsageError(`No rollout files found under ${codexHome}`);
  const index = readIndex();
  const query = values.thread || process.env.CODEX_THREAD_ID;
  const id = query ? resolveThreadID(query, files, index) : [...files].sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)[0].id;
  const matches = files.filter((candidate) => candidate.id === id).sort((a, b) => {
    if (a.archived !== b.archived) return a.archived ? 1 : -1;
    return b.stat.mtimeMs - a.stat.mtimeMs;
  });
  return matches[0];
};

const readSessionMeta = (file) => {
  const descriptor = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(1_048_576);
    const length = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
    let metadata = {};
    let firstUserText = null;
    for (const line of buffer.toString("utf8", 0, length).split("\n")) {
      try {
        const record = JSON.parse(line);
        if (record.type === "session_meta") metadata = record.payload || {};
        if (record.type === "response_item" && record.payload?.type === "message" && record.payload.role === "user") {
          const text = titleTextContent(record.payload.content);
          if (text && !isInjectedContext(text) && !isCompactionSummary(text)) firstUserText = text;
        }
        if (metadata.cwd && firstUserText) return { ...metadata, firstUserText };
      } catch {
        // The final buffer fragment may be a partial line.
      }
    }
    return { ...metadata, firstUserText };
  } finally {
    fs.closeSync(descriptor);
  }
};

const textContent = (content) => {
  const parts = [];
  for (const item of content || []) {
    if (item.type === "input_text" || item.type === "output_text") parts.push(item.text || "");
    else if (item.type === "input_image") {
      const source = item.image_url || "";
      parts.push(`[IMAGE] ${source.startsWith("data:") || !source ? "(embedded image)" : source}`);
    }
    else if (item.type === "input_file") parts.push(`[FILE] ${item.file_url || item.filename || "(embedded)"}`);
  }
  return parts.filter(Boolean).join("\n").trim();
};

const titleTextContent = (content) => (content || [])
  .filter((item) => item.type === "input_text" && item.text)
  .map((item) => item.text.trim())
  .filter(Boolean)
  .join("\n");

const thinkingContent = (summary) => (summary || [])
  .filter((item) => item.type === "summary_text" && item.text)
  .map((item) => item.text.trim())
  .filter(Boolean)
  .join("\n");

const isInjectedContext = (text) => {
  const trimmed = text.trim();
  return (
    /^<(?:environment_context|recommended_plugins|skills_instructions|plugins_instructions|collaboration_mode)>/.test(trimmed)
    || /^<permissions instructions>/.test(trimmed)
    || /^# AGENTS[.]md instructions for [\s\S]*<INSTRUCTIONS>/.test(trimmed)
  );
};

const isCompactionSummary = (text) => /^Another language model started to solve this problem and produced a summary/.test(text.trim());

const derivedThreadTitle = (text) => {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  return normalized.length > 80 ? `${normalized.slice(0, 79)}…` : normalized;
};

async function* readEvents(file) {
  const input = fs.createReadStream(file, { encoding: "utf8" });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  let lineNumber = 0;
  let visibleIndex = 0;
  let previousVisibleWasCompaction = false;
  let malformed = 0;

  for await (const line of lines) {
    lineNumber += 1;
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      malformed += 1;
      continue;
    }

    let event = null;
    if (record.type === "compacted") {
      if (!previousVisibleWasCompaction) {
        event = { kind: "compaction", text: "CONTEXT COMPACTED", timestamp: record.timestamp, lineNumber };
      }
    } else if (record.type === "response_item" && record.payload?.type === "message") {
      const role = record.payload.role;
      if (role === "user" || role === "assistant") {
        const text = textContent(record.payload.content);
        if (text) {
          const rawPhase = record.payload.phase;
          const phase = rawPhase === "final_answer" ? "final" : rawPhase === "commentary" ? "commentary" : null;
          event = { kind: role, role, phase, text, timestamp: record.timestamp, lineNumber, id: record.payload.id || null };
        }
      }
    } else if (record.type === "response_item" && record.payload?.type === "reasoning") {
      const text = thinkingContent(record.payload.summary);
      if (text) event = { kind: "thinking", role: "thinking", phase: null, text, timestamp: record.timestamp, lineNumber, id: record.payload.id || null };
    }

    if (event) {
      previousVisibleWasCompaction = event.kind === "compaction";
      event.index = visibleIndex;
      visibleIndex += 1;
      yield event;
    } else if (record.type !== "compacted") {
      // Ignored tool/system/event records do not separate adjacent compaction records.
    }
  }

  if (malformed > 0) console.error(`Warning: skipped ${malformed} malformed or incomplete JSONL line(s)`);
}

const roles = splitValues(values.role);
const phases = splitValues(values.phase);
const validRoles = new Set(["user", "assistant", "thinking"]);
const validPhases = new Set(["commentary", "final"]);
for (const role of roles) if (!validRoles.has(role)) fail(`Unknown role: ${role}`);
for (const phase of phases) if (!validPhases.has(phase)) fail(`Unknown phase: ${phase}`);

let fromTime;
let toTime;
try {
  fromTime = parseTime(values.from, "--from");
  toTime = parseTime(values.to, "--to");
} catch (error) {
  fail(error.message);
}

const includeEvent = (event) => {
  if (event.kind === "compaction") return !values["no-compactions"];
  if (event.kind === "user" && isCompactionSummary(event.text)) return false;
  if (values["clean-context"] && event.kind === "user" && isInjectedContext(event.text)) return false;
  if (values["final-only"] && (event.kind === "thinking" || (event.kind === "assistant" && event.phase !== "final"))) return false;
  if (event.kind === "thinking" && !values.thinking) return false;
  if (roles.size > 0 && !roles.has(event.role)) return false;
  if (phases.size > 0 && event.kind === "assistant" && !phases.has(event.phase || "")) return false;
  if (phases.size > 0 && event.kind !== "assistant") return false;
  const timestamp = Date.parse(event.timestamp || "");
  if (fromTime !== null && (!Number.isFinite(timestamp) || timestamp < fromTime)) return false;
  if (toTime !== null && (!Number.isFinite(timestamp) || timestamp > toTime)) return false;
  return true;
};

const shortTimestamp = (timestamp) => {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat(undefined, {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(date);
  const value = (type) => parts.find((part) => part.type === type)?.value || "";
  return `${value("month")}-${value("day")} ${value("hour")}:${value("minute")}`;
};

const renderEvent = (event) => {
  if (event.kind === "compaction") return "── CONTEXT COMPACTED ──";
  let label;
  if (event.kind === "user") label = "USER";
  else if (event.kind === "thinking") label = "THINKING";
  else if (event.phase === "commentary") label = "ASSISTANT / COMMENTARY";
  else if (event.phase === "final") label = "ASSISTANT / FINAL";
  else label = "ASSISTANT";
  const time = values.time ? ` ${shortTimestamp(event.timestamp)}` : "";
  return `[${label}${time}]\n${event.text}`;
};

const renderEvents = (events, separator = "\n\n") => events.map(renderEvent).join(separator);

const writeResult = (text) => {
  const output = text.endsWith("\n") ? text : `${text}\n`;
  if (values.output) {
    const target = path.resolve(values.output);
    const relativeToCodexHome = path.relative(codexHome, target);
    if (relativeToCodexHome === "" || (!relativeToCodexHome.startsWith(`..${path.sep}`) && relativeToCodexHome !== ".." && !path.isAbsolute(relativeToCodexHome))) {
      throw new UsageError(`Refusing to write output inside CODEX_HOME: ${target}`);
    }
    fs.writeFileSync(target, output, "utf8");
  } else process.stdout.write(output);
};

const applyOutputLimits = (events) => {
  const defaultMessageLimit = values.output ? Number.POSITIVE_INFINITY : DEFAULT_STDOUT_MESSAGES;
  const defaultCharacterLimit = values.output ? Number.POSITIVE_INFINITY : DEFAULT_STDOUT_CHARACTERS;
  const messageLimit = integerOption(values["max-messages"], "--max-messages", defaultMessageLimit, { minimum: 1 });
  const characterLimit = integerOption(values["max-chars"], "--max-chars", defaultCharacterLimit, { minimum: 1 });
  const selected = [];
  let characters = 0;
  let truncated = false;
  for (const event of events) {
    const rendered = renderEvent(event);
    if (selected.length >= messageLimit || characters + rendered.length > characterLimit) {
      truncated = true;
      break;
    }
    selected.push(event);
    characters += rendered.length + 2;
  }
  return { selected, truncated };
};

const collectVisibleEvents = async (session) => {
  const events = [];
  for await (const event of readEvents(session.file)) if (includeEvent(event)) events.push(event);
  return events;
};

const runCatalog = () => {
  const scope = (values.scope || "active").toLowerCase();
  if (!["active", "archived", "all"].includes(scope)) {
    throw new UsageError("--scope must be active, archived, or all");
  }
  const matchingFiles = allSessionFiles().filter(
    (session) => scope === "all" || session.archived === (scope === "archived"),
  );
  const newestFileByID = new Map();
  for (const session of matchingFiles) {
    const previous = newestFileByID.get(session.id);
    if (
      !previous
      || (previous.archived && !session.archived)
      || (previous.archived === session.archived && previous.stat.mtimeMs < session.stat.mtimeMs)
    ) {
      newestFileByID.set(session.id, session);
    }
  }
  const files = [...newestFileByID.values()];
  const index = readIndex();
  const sessions = files.map((session) => {
    const meta = readSessionMeta(session.file);
    const cwd = meta.cwd || "(unknown project)";
    return {
      ...session,
      cwd,
      project: cwd === "(unknown project)" ? cwd : path.basename(cwd),
      firstUserText: meta.firstUserText,
      record: index.get(session.id),
    };
  });
  const projectQuery = values.project?.toLowerCase();
  const filtered = projectQuery ? sessions.filter(({ project, cwd }) => (
    project.toLowerCase().includes(projectQuery) || cwd.toLowerCase().includes(projectQuery)
  )) : sessions;

  if (values.projects) {
    const counts = new Map();
    for (const session of filtered) counts.set(session.project, (counts.get(session.project) || 0) + 1);
    const output = [...counts]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([project, count]) => `- ${project} (${count})`)
      .join("\n");
    writeResult(output || "No projects found.");
    return;
  }

  const limit = integerOption(values.limit, "--limit", Number.POSITIVE_INFINITY, { minimum: 1 });
  const records = [...filtered].sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs).slice(0, limit);
  const renderEntry = (session, includeProject) => {
    const indexedTitle = String(session.record?.thread_name || "").trim();
    const recoveredTitle = !indexedTitle || /^Untitled(?:\s|$)/i.test(indexedTitle)
      ? derivedThreadTitle(session.firstUserText)
      : indexedTitle;
    const title = String(recoveredTitle || `Untitled (${session.id})`).replaceAll("[", "\\[").replaceAll("]", "\\]");
    const details = [];
    if (includeProject) details.push(session.project);
    if (session.archived) details.push("archived");
    if (values.time) details.push(shortTimestamp(session.stat.mtime.toISOString()));
    return `- [${title}](codex://threads/${session.id})${details.length > 0 ? `  \`${details.join(" · ")}\`` : ""}`;
  };

  let output;
  if (values.flat) {
    output = records.map((session) => renderEntry(session, true)).join("\n");
  } else {
    const byProject = new Map();
    for (const session of records) {
      if (!byProject.has(session.project)) byProject.set(session.project, []);
      byProject.get(session.project).push(session);
    }
    output = [...byProject.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([project, projectSessions]) => `## ${project}\n\n${projectSessions.map((session) => renderEntry(session, false)).join("\n")}`)
      .join("\n\n");
  }
  writeResult(output || "No conversations found.");
};

const main = async () => {
  if (command === "catalog") {
    if (positionals.length > 0) throw new UsageError("catalog does not accept positional arguments");
    runCatalog();
    return;
  }

  const session = resolveSession();
  if (command === "doctor") {
    let visible = 0;
    let thinking = 0;
    let compactions = 0;
    for await (const event of readEvents(session.file)) {
      visible += 1;
      if (event.kind === "thinking") thinking += 1;
      if (event.kind === "compaction") compactions += 1;
    }
    const meta = readSessionMeta(session.file);
    console.log(`Codex home: ${codexHome}`);
    console.log(`Thread: ${session.id}`);
    console.log(`Session: ${session.file}`);
    console.log(`Archived: ${session.archived ? "yes" : "no"}`);
    console.log(`Project: ${meta.cwd || "(unknown)"}`);
    console.log(`Visible events: ${visible}`);
    console.log(`Thinking summaries: ${thinking}`);
    console.log(`Compaction boundaries: ${compactions}`);
    return;
  }

  if (command === "read") {
    if (positionals.length > 0) throw new UsageError("read does not accept positional arguments");
    const tail = integerOption(values.tail, "--tail", null, { minimum: 1 });
    let selectedEvents;
    if (tail === null) {
      selectedEvents = await collectVisibleEvents(session);
    } else {
      selectedEvents = [];
      for await (const event of readEvents(session.file)) {
        if (!includeEvent(event)) continue;
        selectedEvents.push(event);
        if (selectedEvents.length > tail) selectedEvents.shift();
      }
    }
    const { selected, truncated } = applyOutputLimits(selectedEvents);
    let output = renderEvents(selected) || "No visible conversation events.";
    if (truncated) output += "\n\n── OUTPUT TRUNCATED ──";
    writeResult(output);
    return;
  }

  const events = await collectVisibleEvents(session);
  const query = positionals.join(" ").trim();
  if (!query) throw new UsageError("search requires a query");
  const before = integerOption(values.before, "--before", DEFAULT_CONTEXT_COUNT);
  const after = integerOption(values.after, "--after", DEFAULT_CONTEXT_COUNT);
  const maxResults = integerOption(values["max-results"], "--max-results", DEFAULT_SEARCH_RESULTS, { minimum: 1 });
  const offset = integerOption(values.offset, "--offset", 0);
  const order = (values.order || "newest").toLowerCase();
  if (!["newest", "oldest"].includes(order)) throw new UsageError("--order must be newest or oldest");
  let matcher;
  if (values.regex) {
    try {
      matcher = new RegExp(query, values["case-sensitive"] ? "u" : "iu");
    } catch (error) {
      throw new UsageError(`Invalid regular expression: ${error.message}`);
    }
  } else {
    const needle = values["case-sensitive"] ? query : query.toLocaleLowerCase();
    matcher = { test: (text) => (values["case-sensitive"] ? text : text.toLocaleLowerCase()).includes(needle) };
  }

  const allMatches = [];
  for (let index = 0; index < events.length; index += 1) {
    if (matcher.test(events[index].text)) allMatches.push(index);
  }
  const orderedMatches = order === "newest" ? [...allMatches].reverse() : allMatches;
  const matches = orderedMatches.slice(offset, offset + maxResults).sort((a, b) => a - b);
  if (matches.length === 0) {
    writeResult("No matches.");
    return;
  }

  const ranges = [];
  for (const index of matches) {
    const next = { start: Math.max(0, index - before), end: Math.min(events.length - 1, index + after) };
    const previous = ranges.at(-1);
    if (previous && next.start <= previous.end + 1) previous.end = Math.max(previous.end, next.end);
    else ranges.push(next);
  }
  let output = ranges.map(({ start, end }) => renderEvents(events.slice(start, end + 1))).join("\n\n⋯\n\n");
  if (offset + matches.length < orderedMatches.length) {
    output += `\n\n── ${allMatches.length - offset - matches.length} MORE MATCHES OMITTED ──`;
  }
  writeResult(output);
};

main().catch((error) => {
  if (error instanceof UsageError) fail(`${error.message}\n\n${HELP}`);
  fail(error.stack || error.message);
});
