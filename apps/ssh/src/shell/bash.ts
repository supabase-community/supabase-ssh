import { resolve } from 'node:path'
import { Bash, defineCommand, OverlayFs } from 'just-bash'

import { ExtendedMountableFs } from './extended-mountable-fs.js'

const DEFAULT_DOCS_DIR = resolve(process.env.DOCS_DIR ?? '../../docs')

export const EXECUTION_LIMITS = {
  maxCommandCount: 1000,
  maxLoopIterations: 1000,
  maxCallDepth: 50,
  maxSubstitutionDepth: 20,
  maxSourceDepth: 10,
  maxFileDescriptors: 100,
  maxAwkIterations: 1000,
  maxSedIterations: 1000,
  maxJqIterations: 1000,
  maxGlobOperations: 10000,
  maxArrayElements: 10000,
  maxBraceExpansionResults: 1000,
  maxOutputSize: 1024 * 1024, // 1MB
  maxStringLength: 1024 * 1024, // 1MB
  maxHeredocSize: 1024 * 1024, // 1MB
}

const INSTRUCTIONS = `\`\`\`bash
# Search for a topic
ssh supabase.sh grep -rl 'auth' /supabase/docs/

# Read a specific guide
ssh supabase.sh cat /supabase/docs/guides/auth/passwords.md

# Find all guides in a section
ssh supabase.sh find /supabase/docs/guides/database -name '*.md'

# Search with context
ssh supabase.sh grep -r 'RLS' /supabase/docs/guides/auth --include='*.md' -l
\`\`\`

All docs live under \`/supabase/docs/\` as markdown files. You can use any standard Unix tools (grep, find, cat, etc.) to search and read them.`

const AGENTS_MD = `## Supabase Docs

Before working on a Supabase feature, check the docs via \`ssh supabase.sh <command>\`.

${INSTRUCTIONS}
`

const SKILL_MD = `---
name: supabase-docs
description: Search and read Supabase documentation using a bash shell. Use when working on a Supabase feature or troubleshooting a problem.
---

# Supabase Docs

Search and read Supabase documentation over SSH.

## How to use

${INSTRUCTIONS}
`

const SETUP_MD = `# Supabase Docs - Setup

You are helping a user set up access to Supabase documentation via SSH.

1. First tell them the purpose of this tool (docs over ssh/bash)
2. Ask the user which option they prefer (use AskUserQuestion or similar if available)

Options:

1. **Append to agent instructions file (recommended)** - Adds lightweight instructions to the project's agent config file. Most reliable since instructions are always loaded and the footprint is small.
2. **Install as a skill** - Creates a skill directory with a SKILL.md. Skills are loaded on-demand but not always reliable.
3. **Both** - Adds to agent instructions and installs the skill.

After the user chooses, follow the steps below. If you are unsure which agent or tool the user is using, ask them.

## Option 1: Agent instructions file

Run this command and append the output to the project's agent instructions file:

\`\`\`bash
ssh supabase.sh agents >> <instructions-file>
\`\`\`

Common instructions files by tool:

| Tool | File |
|------|------|
| Claude Code | \`CLAUDE.md\` |
| GitHub Copilot | \`AGENTS.md\` |
| Codex | \`AGENTS.md\` |
| Gemini CLI | \`GEMINI.md\` |
| Cursor | \`AGENTS.md\` |
| OpenCode | \`AGENTS.md\` |
| Other | \`AGENTS.md\` |

## Option 2: Skill

Run this command and write the output to the skill directory.

Pick the path that matches the user's tool. \`.agents/skills/\` is a cross-client convention supported by most tools:

| Tool | Skill path |
|------|-----------|
| Claude Code | \`.claude/skills/supabase-docs/SKILL.md\` |
| GitHub Copilot | \`.github/skills/supabase-docs/SKILL.md\` |
| Codex | \`.agents/skills/supabase-docs/SKILL.md\` |
| Gemini CLI | \`.gemini/skills/supabase-docs/SKILL.md\` or \`.agents/skills/supabase-docs/SKILL.md\` |
| Cursor | \`.cursor/skills/supabase-docs/SKILL.md\` or \`.agents/skills/supabase-docs/SKILL.md\` |
| OpenCode | \`.opencode/skills/supabase-docs/SKILL.md\` or \`.agents/skills/supabase-docs/SKILL.md\` |
| Other | \`.agents/skills/supabase-docs/SKILL.md\` |

\`\`\`bash
mkdir -p <skill-dir>/supabase-docs
ssh supabase.sh skill > <skill-dir>/supabase-docs/SKILL.md
\`\`\`

## Option 3: Both

Run both sets of commands above.

After setup, confirm to the user what was written and where.
`

const sshCommand = defineCommand('ssh', async (args) => {
  const cmd = args.join(' ')
  const hint = cmd === 'supabase.sh agents' ? ' >> AGENTS.md' : ''
  return {
    stdout: '',
    stderr:
      'ssh is not available from within this session.\n' +
      'Exit first, then run:\n\n' +
      `  ssh ${cmd}${hint}\n\n`,
    exitCode: 1,
  }
})

/**
 * Creates a sandboxed Bash instance.
 * @param docsDir - Path to docs directory to mount. Defaults to DOCS_DIR env or ../docs/public/docs.
 */
export async function createBash(docsDir = DEFAULT_DOCS_DIR) {
  const fs = new ExtendedMountableFs({
    readOnly: true,
    initialFiles: {
      '/supabase/AGENTS.md': AGENTS_MD,
      '/supabase/SKILL.md': SKILL_MD,
      '/supabase/SETUP.md': SETUP_MD,
    },
    mounts: [
      {
        mountPoint: '/supabase/docs',
        filesystem: new OverlayFs({ root: docsDir, mountPoint: '/', readOnly: true }),
      },
    ],
  })

  const bash = new Bash({
    fs,
    cwd: '/supabase',
    env: {
      HOME: '/supabase',
      BASH_ALIAS_ll: 'ls -alF',
      BASH_ALIAS_la: 'ls -a',
      BASH_ALIAS_l: 'ls -CF',
      BASH_ALIAS_agents: 'echo && cat /supabase/AGENTS.md',
      BASH_ALIAS_skill: 'echo && cat /supabase/SKILL.md',
      BASH_ALIAS_setup: 'cat /supabase/SETUP.md',
    },
    customCommands: [sshCommand],
    defenseInDepth: true,
    executionLimits: EXECUTION_LIMITS,
  })

  // Enable alias expansion
  await bash.exec('shopt -s expand_aliases')

  return { bash, fs }
}
