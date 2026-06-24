---
name: memory-prune
description: Prune and clean project memories (RAG-lite) by removing error messages, old entries, and low-value memories. Use after memory-review or when memories are getting cluttered with noise.
---

# Memory Prune Skill

## Overview

This skill prunes the "Project Memory (RAG-lite)" entries stored in `~/.pi/memory-v2/projects/*.jsonl`. It can:
- Remove error messages and tool failure memories
- Remove old entries with low access counts
- Remove duplicate memories
- Compact the memory store (keep most recent + most accessed)

## When to Use

- After reviewing memories with `/skill:memory-review`
- When you notice memories getting cluttered with error messages
- Periodically to keep memory store lean and relevant
- When context shows too many old `tool-failure` or `tool-retry` entries

## Memory Storage Format

Memories are stored as JSONL in:
- `~/.pi/memory-v2/projects/<project-key>.jsonl` (project-scoped)
- `~/.pi/memory-v2/teams/<team-key>.jsonl` (team-scoped)

Each record:
```json
{
  "id": "unique-id",
  "text": "memory content",
  "scope": "project",
  "tags": ["auto-dream", "lesson", "high"],
  "createdAt": 1234567890,
  "updatedAt": 1234567890,
  "lastAccessedAt": 1234567890,
  "accessCount": 3
}
```

## Pruning Strategies

### Strategy 1: Remove Error Messages (Recommended First Step)

Remove memories with error-related tags that are old or rarely accessed:

```bash
# Read the memory file
memory_file="$HOME/.pi/memory-v2/projects/$(echo "$PWD" | sed 's/[^a-zA-Z0-9._-]/_/g' | tr '[:upper:]' '[:lower:]' | cut -c1-120).jsonl"
echo "Pruning: $memory_file"
```

Criteria for removal:
- Tags include `tool-failure` OR `tool-retry` OR `tool-fingerprint`
- AND (`updatedAt` is older than 30 days OR `accessCount` is 0)

### Strategy 2: Remove Low-Access Old Entries

```bash
# Keep entries that:
# - Have been accessed at least once recently, OR
# - Are tagged as important (objective, preference, completion, code-change)
```

### Strategy 3: Full Compact (Like /memory-prune Command)

The built-in `/memory-prune` command:
1. Loads all records
2. Deduplicates exact matches (by text)
3. Prunes to max 800 records:
   - Always keeps the 220 most recent (by `updatedAt`)
   - Then keeps highest-scored remaining (by `(log1p(accessCount) + 1) / (1 + ageDays)`)
4. Writes back

## Implementation Steps

### Step 1: Read the memory file

```bash
# Find the project memory file
cwd="/home/patze/.pi/agent"  # or use actual cwd
project_key=$(echo "$cwd" | sed 's/[^a-zA-Z0-9._-]/_/g' | tr '[:upper:]' '[:lower:]' | cut -c1-120)
memory_file="$HOME/.pi/memory-v2/projects/${project_key}.jsonl"
team_file="$HOME/.pi/memory-v2/teams/$(echo "$cwd" | sed 's/[^a-zA-Z0-9._-]/_/g' | tr '[:upper:]' '[:lower:]' | cut -c1-120).jsonl"

echo "Project memory: $memory_file"
echo "Team memory: $team_file"
```

Use `read` to load the file, then parse each line as JSON.

### Step 2: Filter records

For each record, decide whether to KEEP or PRUNE:

**Always KEEP:**
- `objective` tag - user's session objectives
- `preference` tag - user preferences
- `completion` tag - task completion summaries
- `code-change` tag - what was changed
- `high` severity lessons (recent)
- Records with `accessCount >= 3` (frequently accessed)

**Consider PRUNING:**
- `tool-failure` OR `tool-retry` OR `tool-fingerprint` tags:
  - If `accessCount === 0` AND older than 14 days → PRUNE
  - If `accessCount === 1` AND older than 30 days → PRUNE
- `lesson` + `low` severity + older than 60 days + low access → PRUNE
- `harness-bug` / `workaround` + older than 90 days + low access → PRUNE
- `hang-fix` / `loop-detector` / `high-error-rate` + older than 60 days → PRUNE

**Always PRUNE:**
- Duplicate entries (same `text` after trimming/lowercasing)
- Entries with `text` containing stack traces or very long error outputs (>500 chars of error)

### Step 3: Write filtered records back

After filtering, write the remaining records back to the JSONL file:

```javascript
// Pseudocode for the agent
const fs = require('fs');
const records = []; // Your filtered records
const content = records.map(r => JSON.stringify(r)).join('\n') + (records.length > 0 ? '\n' : '');
fs.writeFileSync(memory_file, content, 'utf-8');
```

Or use the `write` tool to write the filtered JSONL content.

### Step 4: Report results

Present a summary:

```
## Memory Prune Results

**File**: ~/.pi/memory-v2/projects/_home_patze_.pi_agent.jsonl

**Before**: 42 entries
**After**: 28 entries
**Removed**: 14 entries

### Removed by category:
- Error messages (tool-failure/retry): 8
- Old low-access lessons: 4
- Duplicates: 2

**Kept**: 28 entries
- Objectives: 2
- Preferences: 3
- Completions: 4
- Code changes: 5
- High/medium lessons: 8
- Other: 6
```

## Quick Prune (Minimal)

For a quick prune that just removes the most obvious noise:

```bash
# Use the built-in command (if available)
/memory-prune
```

Or manually:
1. Read the JSONL file
2. Remove any record with `tags` including `tool-failure` AND `accessCount === 0`
3. Remove any record with `tags` including `tool-retry` AND `accessCount === 0`
4. Remove duplicates (by text)
5. Write back

## Notes

- The memory system has a built-in `/memory-prune` command that does compaction
- This skill provides more targeted pruning (removing error messages specifically)
- After pruning, the memory store is automatically used in future sessions
- Consider running `/skill:memory-review` first to see what would be pruned
