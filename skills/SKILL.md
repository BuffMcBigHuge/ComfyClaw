---
name: comfyclaw
description: Run ComfyUI workflows via CLI. Use --list to discover workflows, --describe to see editable parameters (with live server values), --run to execute with --set @tag overrides. No need to read workflow files directly.
---

# ComfyClaw Skill

A CLI tool for discovering, inspecting, and executing ComfyUI workflows.

> **You do not need to read workflow JSON files.** Use the CLI commands below to discover workflows, see what's editable, and run them.

## Quick Reference

```bash
cd <ComfyClaw directory>

# List available workflows
node cli.js --list

# See editable parameters (queries live server for valid values)
node cli.js --describe <workflow>

# Run a workflow with overrides
node cli.js --run <workflow> [outDir] --set @tag.key=value ...
```

---

## 1. Discover Workflows (`--list`)

```bash
node cli.js --list
```

Prints available workflow names. Use these names with `--describe` and `--run`.

---

## 2. Inspect a Workflow (`--describe`)

```bash
node cli.js --describe text2image-example
```

Shows every `@tag` in the workflow and its editable parameters. If a ComfyUI server is reachable, it queries the server to show all valid values for enum inputs (checkpoints, samplers, schedulers). The currently selected value is marked with ★.

**Key rules:**
- **editable** params are safe to override via `--set`
- **linked** params are graph wiring — do NOT override these
- If a workflow has no `@tags`, use raw node IDs (`--set nodeId.key=value`)

---

## 3. Run a Workflow (`--run`)

```bash
node cli.js --run <workflow> [outDir] [--set @tag.key=value ...]
```

### Override syntax

Tag-based (recommended):
```bash
--set @prompt.text="a beautiful sunset over the ocean"
--set @ksampler.steps=30
--set @ksampler.seed=42
```

Node-ID based (for workflows without @tags):
```bash
--set 6.text="a beautiful sunset"
--set 3.steps=30
```

### Full example

```bash
node cli.js --run text2image-example outputs \
  --set @prompt.text="cinematic neon city at night, rain, 35mm" \
  --set @negative.text="watermark, text, logo, blurry" \
  --set @ksampler.seed=111111 \
  --set @ksampler.steps=25 \
  --set @ksampler.cfg=7 \
  --set @size.width=768 \
  --set @size.height=768
```

### Exit codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Runtime error (server unavailable, execution failed, timeout) |
| 2 | Usage error (bad arguments, workflow not found) |

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `COMFYUI_SERVER` | (auto-select) | Force a specific server URL |
| `COMFYUI_TIMEOUT_MS` | `180000` | Max wait for completion (ms) |

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| "All ComfyUI servers unavailable" | Verify server: `curl http://localhost:8188/api/queue` |
| "No Save node detected" | Workflow needs a SaveImage or `@save` tagged node |
| "Tag @xyz not found" | Run `--describe` to see available tags |
| "Tag @xyz is ambiguous" | Each `@tag` must be unique within a workflow |
| Timeout | Increase `COMFYUI_TIMEOUT_MS` or check server load |
| "Value not in list" | Run `--describe` to see valid values from server |
