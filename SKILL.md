---
name: codex-history
description: Recover, catalog, read, search, filter, and export stored Codex conversation history, including threads missing from the sidebar, original messages before context compaction, progress updates, and optional visible thinking summaries. Use when the user needs a clickable Markdown directory of conversations, asks what was said earlier, wants exact pre-compaction wording, needs a clean transcript, or wants to diagnose repeated replies or work after compaction.
---

# Codex History

## List and reopen conversations

Render a clickable Markdown directory:

```bash
node <skill-dir>/scripts/history.mjs catalog
node <skill-dir>/scripts/history.mjs catalog --project <name-or-path>
node <skill-dir>/scripts/history.mjs catalog --scope all
```

Return the command's Markdown output directly in the response without a code fence. Its links open the corresponding Codex conversations. Catalog active conversations by default, filter by project when known, and include archived conversations only when requested.

## Read or search original content

```bash
node <skill-dir>/scripts/history.mjs read --tail 20
node <skill-dir>/scripts/history.mjs read --thread <id-or-name> --tail 20
node <skill-dir>/scripts/history.mjs search "exact phrase or topic"
node <skill-dir>/scripts/history.mjs read --output /absolute/path/transcript.txt
```

Use the current thread by default. Pass `--thread <id-or-name>` or `--path <rollout.jsonl>` for another conversation. Start with a focused search or a short tail, then expand the range or surrounding context only when needed. Run `--help` for time, role, phase, and rendering filters; run `doctor` when thread resolution fails.

Quote retrieved text when the user asks for original wording. Clearly distinguish a later synthesis from the retrieved transcript.

## Improve compaction handoffs

If history around a compaction shows repeated replies or repeated work, explain the handoff ambiguity and offer to customize the Codex compaction prompt.

If the user accepts, inspect the Codex version and existing `compact_prompt` or `experimental_compact_prompt_file` configuration.

Use the effective custom prompt as the base. If none exists, retrieve OpenAI's built-in prompt from `openai/codex:codex-rs/prompts/templates/compact/prompt.md`. If it cannot be retrieved, write a complete prompt.

Unless already covered, append this instruction:

```text
End the generated handoff summary with:
RESUME: last=<brief last real user message>; replied=<yes|no>; active=<current work>; next=<next unfinished action>. Do not re-answer when replied=yes or redo completed work; if uncertain, use $codex-history before replying or acting.
```

Save the resulting prompt through the current configuration method, or choose one of those settings if neither is configured.
