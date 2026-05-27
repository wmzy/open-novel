# Open Novel Design Spec

AI-assisted novel writing web application. Delegates AI work to external agent CLIs (Claude Code, OpenCode, etc.), manages project structure, and provides rich visualization views for characters, world-building, and story elements.

## Background

The original `opencode-novel-plugin` is a CLI plugin for OpenCode that provides a complete novel-writing workflow (6 stages, 3 agents, 11 commands, 5 skills). It works well but lacks visual representation of story elements. This project restructures it as a standalone web application following open-design's agent delegation architecture, using anthology's Vite-based tech stack.

Key motivations:
- Rich visualization views for characters, relationships, world-building, foreshadow tracking
- Agent delegation pattern (spawn external CLIs) instead of direct AI provider calls
- Plugin architecture for extensibility (wuxia, reality mapping, future genres)

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 19 |
| Styling | Linaria (zero-runtime CSS-in-JS) via @wyw-in-js |
| UI components | haze-ui |
| Routing | React Router DOM v7 |
| Server state | TanStack React Query v5 |
| Client state | React Context |
| API framework | Hono |
| Database | PostgreSQL via Drizzle ORM, PGlite for dev |
| Validation | Zod v4 |
| Logging | Pino |
| Build tool | Vite 8 |
| Language | TypeScript 5.9 strict |
| Package manager | pnpm |

No AI SDKs — agents handle all AI interactions. The app spawns agent CLIs and parses their output streams.

## Project Structure

```
open-novel/
  src/
    api/                    # Hono API routes
      routes/
        projects.ts         # /api/projects CRUD
        chapters.ts         # /api/chapters CRUD
        runs.ts             # /api/runs (agent run management)
        agents.ts           # /api/agents (discovery)
        plugins.ts          # /api/plugins (listing)
        settings.ts         # /api/settings
    web/                    # React frontend
      components/
        views/
          ConceptView.tsx
          WorldView.tsx
          CharacterView.tsx
          OutlineView.tsx
          SceneView.tsx
          ForeshadowView.tsx
          WuxiaView.tsx
          DashboardView.tsx
        ChatPanel.tsx
        EditorPanel.tsx
        Sidebar.tsx
        WorkflowProgress.tsx
        AgentMessage.tsx
        ToolCard.tsx
      pages/
        Home.tsx
        Project.tsx
        Settings.tsx
      hooks/
        useRun.ts
        useProject.ts
        useChapters.ts
      styles/
        global.ts
    agent/                  # Agent spawning system
      registry.ts           # Agent definitions
      detection.ts          # PATH scanning, --version probing
      launch.ts             # Binary resolution, spawn()
      stream-parser.ts      # Unified stream parser
      run.ts                # Run lifecycle
      types.ts
    plugins/                # Plugin system
      loader.ts             # SKILL.md + manifest parser
      registry.ts           # Plugin registry
      types.ts
    db/                     # Database
      schema.ts             # Drizzle schema
      drizzle.ts            # DB connection (PGlite/PostgreSQL)
      migrations/
    templates/              # Document templates
    prompts/                # RTCO prompt templates
    utils/                  # Shared utilities
  plugins/                  # External plugin directory
    novel/
      SKILL.md
      open-novel.json
    wuxia/
      SKILL.md
      open-novel.json
    reality/
      SKILL.md
      open-novel.json
  data/                     # Runtime data (PGlite, project files)
  public/                   # Static assets
```

## Agent System

The app delegates all AI work to external agent CLIs. Core components in `src/agent/`.

### Agent Discovery

Scan PATH for known agents (`claude`, `opencode`, `codex`, etc.), probe with `--version`, return available list. Users select their preferred agent in settings.

### Run Lifecycle

1. User sends message in web UI
2. `POST /api/runs` — compose prompt (system prompt + skill content + project context + user message), spawn agent CLI with `cwd` set to project directory
3. `GET /api/runs/:id/events` — SSE stream to frontend
4. Agent stdout → stream parser → normalized events → SSE
5. Agent exits → end event

### Prompt Composition

```
System prompt:
  - Base app instructions (file structure, tool usage)
  + Active skill SKILL.md content (novel-writing rules, anti-AI patterns)
  + Stage-specific instructions (e.g., "你现在处于概念设计阶段")
  + Relevant templates (e.g., concept.md template)

User message:
  - User's input (or auto-generated stage prompt)
  + Project context (existing files, current progress)
```

### Normalized Events

All agent output formats are normalized to:
- `text_delta` — assistant text chunks
- `tool_use` — tool invocations (file read/write/edit)
- `tool_result` — tool results
- `thinking_delta` — thinking blocks
- `status` — lifecycle markers
- `error` — error frames

### Interactive Tools

For agents that support `AskUserQuestion` (like Claude Code), the frontend shows the question and posts the answer back via `POST /api/runs/:id/tool-result`.

## Plugin System

Skills follow open-design's SKILL.md convention. Core in `src/plugins/`.

### Plugin Structure

```
plugins/
  novel/
    SKILL.md           # Skill content (injected into agent system prompt)
    open-novel.json    # Manifest: metadata, workflow stages, templates
  wuxia/
    SKILL.md
    open-novel.json
  reality/
    SKILL.md
    open-novel.json
```

**SKILL.md** — The actual skill content (instructions, examples, rules). Gets injected into the agent's system prompt when this skill is active.

**open-novel.json** — Manifest:
```json
{
  "id": "novel",
  "name": "小说创作",
  "description": "完整的小说创作工作流",
  "version": "1.0.0",
  "stages": ["concept", "world", "characters", "outline", "scenes", "writing"],
  "templates": ["concept.md", "world-building.md", "characters/"],
  "legacyTools": ["init", "status", "save", "context", "guide", "track"]
}
```

`legacyTools` is metadata for reference only — agents use their built-in file tools (Read, Write, Edit) instead of custom tools.

### Loading

On app startup, scan `plugins/` directory, parse each SKILL.md + JSON pair, register in memory. The active skill determines which SKILL.md content goes into the agent prompt.

### Templates

Document templates (concept.md, world-building.md, etc.) live inside each plugin's directory. When a user initializes a project, templates are copied to the project folder.

## Data Model

Database schema (Drizzle ORM) for structured data. File system for novel content.

### Database Tables

```sql
projects              # Novel projects
  id, title, genre, target_words, chapter_count, theme, perspective
  current_stage, created_at, updated_at

chapters              # Chapter metadata
  id, project_id, number, title, word_count, status
  created_at, updated_at

conversations         # Agent chat sessions
  id, project_id, agent_id, stage, created_at

messages              # Chat messages
  id, conversation_id, role, content, created_at

runs                  # Agent run tracking
  id, conversation_id, agent, status, started_at, finished_at

user_settings         # API keys, preferences
  id, key, value
```

### File System (per project)

```
data/projects/{project-id}/
  .novel/
    config.json           # Project config
    concept.md            # Story concept
    world-building.md     # World building
    characters/
      profiles.md         # Character overview
      {name}.md           # Individual profiles
      state.json          # Character states
    outline-brief.md      # Brief outline
    outline-detailed.md   # Detailed outline
    scenes.md             # Scene design
    summary.md            # Running summary
    foreshadow.json       # Foreshadow tracking
    chapters/
      chapter-001.md      # Chapter content
      chapter-002.md
```

**Why hybrid**: Database for queries (project list, search, stats). Files for novel content (agents read/write markdown naturally, easy to export/backup). The agent's `cwd` is set to the project directory, so it can directly read/write `.novel/` files using its built-in tools.

## API Design

Hono routes in `src/api/`.

### Endpoints

```
# Projects
GET    /api/projects                    # List projects
POST   /api/projects                    # Create project
GET    /api/projects/:id                # Get project
PATCH  /api/projects/:id                # Update project
DELETE /api/projects/:id                # Delete project

# Chapters
GET    /api/projects/:id/chapters       # List chapters
GET    /api/projects/:id/chapters/:num  # Get chapter content
PATCH  /api/projects/:id/chapters/:num  # Update chapter

# Agent Runs
POST   /api/runs                        # Create run (spawn agent)
GET    /api/runs/:id/events             # SSE stream
POST   /api/runs/:id/tool-result        # Answer agent question
DELETE /api/runs/:id                    # Cancel run

# Agents
GET    /api/agents                      # List available agents
GET    /api/agents/:id/models           # List agent models

# Plugins
GET    /api/plugins                     # List installed plugins
GET    /api/plugins/:id                 # Get plugin details

# Settings
GET    /api/settings                    # Get settings
PATCH  /api/settings                    # Update settings
```

### Run Creation

`POST /api/runs`:
```json
{
  "projectId": "xxx",
  "agentId": "claude",
  "skillId": "novel",
  "message": "帮我设计故事概念",
  "stage": "concept"
}
```

The server composes the prompt (system prompt + skill SKILL.md + project context), spawns the agent, returns `{ runId }`. Frontend subscribes to SSE at `GET /api/runs/:id/events`.

## Frontend Architecture

React SPA with chat-centric workspace and rich visualization views.

### Project Workspace Layout

```
┌─────────────┬──────────────────────┬─────────────┐
│             │                      │             │
│  Sidebar    │   Main Panel         │   Chat      │
│             │                      │   Panel     │
│  - Workflow │   Editor or          │             │
│    stages   │   Visualization View │  Agent      │
│  - Chapter  │                      │  conversation│
│    list     │                      │             │
│  - Quick    │                      │             │
│    links    │                      │             │
│             │                      │             │
└─────────────┴──────────────────────┴─────────────┘
```

### Chat Flow

User types message → `useRun` creates a run → SSE stream → `AgentMessage` renders text/tool use/thinking in real-time → agent edits files → editor/views auto-refresh.

### Editor

`@uiw/react-md-editor` for chapter editing. Auto-saves to `.novel/chapters/`. Shows word count.

### Visualization Views

Dedicated views for each story element:

**ConceptView** — Story concept card (one-sentence pitch, five-sentence synopsis, core conflict, moral premise, dilemma points).

**WorldView** — World building (geography, society, power systems, culture, world rules).

**CharacterView** — Character profiles with:
- Character cards (avatar, role, drive triangle, arc)
- Relationship graph (interactive node graph)
- State timeline (status changes across chapters)

**OutlineView** — Story structure:
- 3-act structure timeline visualization
- Chapter cards with scene breakdown
- Drag to reorder chapters

**SceneView** — Scene list with progress (pending/in-progress/done), active/passive alternation.

**ForeshadowView** — Kanban-style board: pending → planted → resolved. Link foreshadows to chapters.

**WuxiaView** — Wuxia-specific:
- Martial arts system hierarchy tree
- Sect faction map
- Weapon spectrum cards

**DashboardView** — Overview:
- Total word count, per-chapter bar chart
- Workflow stage progress
- Recent activity

### Workflow Progress

Visual indicator of current stage (concept → world → characters → outline → scenes → writing). Each stage shows completion status based on which files exist. Clicking a stage navigates to the relevant view.

## Workflow Design

The novel-writing workflow maps to agent interactions. Each stage has a specific prompt composition.

### Stage Flow

```
User selects stage → App loads skill + stage templates → Composes prompt → Spawns agent → Agent guides user through stage → Agent writes files → Stage complete → Views update
```

### Stages

1. **Concept** → Agent guides user through concept design, writes `concept.md`
2. **World** → Agent guides world-building, writes `world-building.md`
3. **Characters** → Agent designs characters, writes character files
4. **Outline** → Agent creates brief + detailed outline
5. **Scenes** → Agent decomposes into scenes
6. **Writing** → Agent writes chapters one by one

### Auto-detection

The app checks which `.novel/` files exist to determine current stage. Agent can also advance stages by creating the required files.

### Tool Mapping

The original plugin's 6 tools map to agent capabilities:
- `novel_init` → Agent creates `.novel/` structure
- `novel_status` → Agent reads files and reports status
- `novel_save_chapter` → Agent writes chapter files
- `novel_context` → App assembles context, injects into prompt
- `novel_guide` → Included in skill SKILL.md
- `novel_update` → Agent edits tracking files directly

The agent uses its built-in file tools (Read, Write, Edit) instead of custom tools.

## Error Handling

**Agent errors:**
- Agent not found → show installation guide in settings
- Agent crash → surface stderr, allow retry
- Stream timeout (10min inactivity) → auto-cancel, notify user
- Invalid agent response → fallback to raw output display

**File conflicts:**
- Agent writes while user is editing → auto-reload editor, show diff
- Concurrent runs on same project → queue or reject with message

## Testing Strategy

- **Unit**: Plugin loader, stream parser, prompt composition, file utils
- **Integration**: API routes with PGlite, agent spawn mocking
- **E2E**: Full workflow (create project → run through stages → write chapter) with Playwright
