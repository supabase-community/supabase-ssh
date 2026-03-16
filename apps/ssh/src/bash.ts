import { resolve } from 'node:path'
import { Bash, defineCommand, InMemoryFs, MountableFs, OverlayFs } from 'just-bash'

const DEFAULT_DOCS_DIR = resolve(process.env.DOCS_DIR ?? '../docs/public/docs')

const aliasCommands = [
  defineCommand('ll', (args, ctx) => ctx.exec!(`ls -alF ${args.join(' ')}`, { cwd: ctx.cwd })),
  defineCommand('la', (args, ctx) => ctx.exec!(`ls -a ${args.join(' ')}`, { cwd: ctx.cwd })),
  defineCommand('l', (args, ctx) => ctx.exec!(`ls -CF ${args.join(' ')}`, { cwd: ctx.cwd })),
]

/**
 * MountableFs doesn't proxy sync methods to its base fs, so just-bash's
 * initFilesystem skips creating /bin, /tmp, /dev, etc. and registerCommand
 * can't write command stubs. This subclass exposes the base InMemoryFs's
 * sync methods so the full Unix directory structure is initialized.
 */
class SyncMountableFs extends MountableFs {
  #base: InMemoryFs

  constructor(opts?: Omit<ConstructorParameters<typeof MountableFs>[0], 'base'>) {
    const base = new InMemoryFs()
    super({ ...opts, base })
    this.#base = base
  }

  mkdirSync(path: string, options?: { recursive?: boolean }) {
    return this.#base.mkdirSync(path, options)
  }

  writeFileSync(path: string, content: string | Uint8Array) {
    return this.#base.writeFileSync(path, content)
  }
}

/**
 * Creates a sandboxed Bash instance.
 * @param docsDir - Path to docs directory to mount. Defaults to DOCS_DIR env or ../docs/public/docs.
 */
export function createBash(docsDir = DEFAULT_DOCS_DIR) {
  return new Bash({
    fs: new SyncMountableFs({
      mounts: [
        {
          mountPoint: '/supabase/docs',
          filesystem: new OverlayFs({ root: docsDir, mountPoint: '/', readOnly: true }),
        },
      ],
    }),
    cwd: '/supabase',
    customCommands: aliasCommands,
    defenseInDepth: true,
    executionLimits: {
      maxCommandCount: 1000,
      maxLoopIterations: 1000,
      maxAwkIterations: 1000,
      maxSedIterations: 1000,
      maxJqIterations: 1000,
      maxGlobOperations: 10000,
      maxArrayElements: 10000,
      maxBraceExpansionResults: 1000,
      maxOutputSize: 1024 * 1024, // 1MB
      maxStringLength: 1024 * 1024, // 1MB
      maxHeredocSize: 1024 * 1024, // 1MB
    },
  })
}
