import { resolve } from 'node:path'
import { Bash, defineCommand, OverlayFs } from 'just-bash'

import { ExtendedMountableFs } from './extended-mountable-fs.js'

const DEFAULT_DOCS_DIR = resolve(process.env.DOCS_DIR ?? '../docs/public/docs')

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

const AGENTS_MD = `

## Supabase Docs

Before working on a Supabase feature, check the docs via \`ssh supabase.sh <command>\`.

\`\`\`bash
# Search for a topic
ssh supabase.sh grep -rl 'auth' /supabase/docs/

# Read a specific guide
ssh supabase.sh cat /supabase/docs/guides/auth/passwords.md

# Find all guides in a section
ssh supabase.sh find /supabase/docs/guides/database -name '*.md'

# Search with context
ssh supabase.sh grep -r 'RLS' /supabase/docs/guides/auth --include='*.md' -l
\`\`\`

All docs live under \`/supabase/docs/\` as markdown files. You can use any standard Unix tools (grep, find, cat, etc.) to search and read them.
`

const agentsCommand = defineCommand('agents', async () => ({
  stdout: AGENTS_MD,
  stderr: '',
  exitCode: 0,
}))

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
    },
    customCommands: [agentsCommand, sshCommand],
    defenseInDepth: true,
    executionLimits: EXECUTION_LIMITS,
  })

  // Enable alias expansion
  await bash.exec('shopt -s expand_aliases')

  return { bash, fs }
}
