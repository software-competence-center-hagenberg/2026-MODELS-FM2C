---
name: memory-review
description: Review project memories (RAG-lite) to identify problems and suggest concrete improvements to prevent issues and improve the agent's behavior. Use when memories show recurring problems or before optimizing agent workflows.
---

# Memory Review & Improvement Suggestions Skill

## Overview

This skill reviews the "Project Memory (RAG-lite)" entries and provides:
1. **Root cause analysis** of recurring problems
2. **Concrete suggestions** to prevent issues
3. **Agent improvement ideas** (how I should behave differently)
4. **Pruning recommendations** (what to remove)

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

## Review Process

### Step 1: Read Memory Files

```bash
# Find the project memory file
cwd="/home/patze/.pi/agent"  # or use actual cwd
project_key=$(echo "$cwd" | sed 's/[^a-zA-Z0-9._-]/_/g' | tr '[:upper:]' '[:lower:]' | cut -c1-120)
memory_file="$HOME/.pi/memory-v2/projects/${project_key}.jsonl"
echo "Reviewing: $memory_file"
```

Use `read` to load all records.

### Step 2: Categorize and Analyze

Group memories by tags and analyze patterns:

#### Category A: Tool Failures (`tool-failure`, `tool-retry`, `tool-fingerprint`)
**Questions to ask:**
- Which tools fail most often? (bash, edit, read, etc.)
- What are the common error patterns?
- Are arguments wrong? Is the tool itself unreliable?

**Improvement suggestions for the agent:**
- **Before calling `bash`**: Validate command syntax, check if files exist, verify working directory
- **Before calling `edit`**: Read the file first, verify oldText matches exactly, check file permissions
- **For retry loops**: After 2 failures, switch to fallback flow or ask user for clarification
- **For `bash` hangs**: Always use `tmux-bash` for commands that might hang (>30s estimated)

#### Category B: Session Management Issues (`hang-fix`, `loop-detector`, `high-error-rate`)
**Questions to ask:**
- Are we getting stuck in loops?
- Are we trying to run blocking operations in the foreground?
- Is the error rate >30%?

**Improvement suggestions for the agent:**
- **Never use `bash sleep`** for coordination — use `semaphore_wait()` instead
- **Always use `tmux-bash`** for: docker, build, dev server, long test suites
- **Escalate to bug-hunt worker** if initial triage can't find root cause
- **Single-dispatch rule**: Send complete task brief in ONE `tmux-send` call, never drip-feed
- **If error rate >30%**: Pause and audit the plan before issuing more tool calls

#### Category C: Workarounds & Bugs (`harness-bug`, `workaround`)
**Questions to ask:**
- What bugs in pi itself are causing friction?
- What workarounds are we using repeatedly?

**Improvement suggestions:**
- **Report pi framework bugs** to the developers (https://github.com/badlogic/pi-mono)
- **Fix root causes** instead of accumulating workarounds
- **Document workarounds** in the skill/extension for future sessions

#### Category D: User Preferences & Objectives (`preference`, `objective`)
**Use these to improve behavior:**
- Adapt communication style (British persona, technical accuracy, etc.)
- Remember what the user values (clean code, specific tools, etc.)
- Note what the user considers "done"

### Step 3: Generate Improvement Report

Create a report like:

```
## Memory Review & Improvement Report

**File**: ~/.pi/memory-v2/projects/_home_patze_.pi_agent.jsonl
**Total entries**: 42
**Review date**: 2026-04-28

---

### 🔴 High Priority Issues

#### 1. Tool "bash" failed 18 times — high retry rate
**Root cause**: Wrong arguments or flaky tool
**Pattern**: Happens when running [specific commands]
**Suggestions**:
- ✅ **Agent improvement**: Before calling bash, validate arguments. Check if command exists with `which` or `command -v`
- ✅ **Agent improvement**: If retry count >2, switch to fallback flow (tmux-bash or ask user)
- ✅ **Preventive measure**: Add argument validation helper function

#### 2. Session error rate 45% — high-error-rate
**Root cause**: Multiple tools failing repeatedly
**Suggestions**:
- ✅ **Agent improvement**: When error rate >30%, PAUSE and audit the plan
- ✅ **Agent improvement**: Use `kanban_spawn` for complex tasks instead of doing them directly
- ✅ **Config change**: Consider increasing `reserveTokens` or `keepRecentTokens` in compaction settings

---

### 🟡 Medium Priority Issues

#### 3. Tool "edit" failed 2 times — argument issues
**Root cause**: oldText doesn't match exactly
**Suggestions**:
- ✅ **Agent improvement**: Always `read` the file before `edit`. Verify oldText matches exactly
- ✅ **Agent improvement**: Keep edits minimal — change as little as possible
- ✅ **Use `vim_edit`** for precise cursor-relative edits when edit/replace would be awkward

---

### 🟢 Low Priority / Informational

#### 4. User preference: "Be direct, warm, and a bit cheeky"
**Action**: Continue with Modern British persona, mild profanity allowed
**Note**: This is working well, no changes needed

---

### 📋 Agent Behavior Changes (Action Items)

Based on this review, I should:

1. **Before any `bash` call**:
   - Validate command syntax
   - Use `tmux-bash` for estimated >30s commands
   - If retry >2, switch to fallback or ask user

2. **Before any `edit` call**:
   - `read` the file first
   - Verify oldText matches exactly
   - Keep edits minimal and unique

3. **For session management**:
   - Never use `bash sleep` — use `semaphore_wait()`
   - Use `tmux-bash` for docker/build/dev server
   - Escalate to bug-hunt worker if stuck

4. **For error handling**:
   - If error rate >30%, PAUSE and audit
   - After 2 tool failures, try fallback flow
   - Report pi bugs instead of accumulating workarounds

---

### 🧹 Pruning Recommendations

**Safe to prune** (no longer actionable):
- tool-failure entries >60 days old with accessCount 0
- tool-retry entries >60 days old with accessCount 0
- Duplicate entries (same text)

**Keep** (valuable context):
- High/medium severity lessons (recent)
- User preferences and objectives
- Completion summaries
- Code-change records

**Next step**: Run `/skill:memory-prune` to clean up the safe-to-prune entries.
```

## Integration with memory-prune

After generating the improvement report:
1. Share the report with the user
2. Ask if they want to implement any of the suggestions
3. Offer to run `/skill:memory-prune` to clean up the identified noise

## Special Note: Learning from Lessons

The "Lessons Learned (from past sessions)" section in my prompt is extracted from these memories. When you see:
- **harness-bug**: I should report the bug, not just work around it
- **workaround**: I should try to fix the root cause next time
- **tool-failure/retry**: I should check arguments first, then use fallback
- **hang-fix**: I MUST use `tmux-bash` for blocking ops
- **loop-detector**: Escalate to dedicated worker, don't iterate forever
- **high-error-rate**: Pause and audit before continuing

These aren't just memories — they're **actionable intelligence** for improving my behavior.
