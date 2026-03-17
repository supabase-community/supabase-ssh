import { InMemoryFs, MountableFs, type MountableFsOptions } from 'just-bash'

interface ExtendedMountableFsOptions extends Omit<MountableFsOptions, 'base'> {
  readOnly?: boolean
}

/**
 * Extends MountableFs with sync method proxying and optional read-only mode.
 *
 * MountableFs doesn't proxy sync methods to its base fs, so just-bash's
 * initFilesystem skips creating /bin, /tmp, /dev, etc. and registerCommand
 * can't write command stubs. This subclass exposes the base InMemoryFs's
 * sync methods so the full Unix directory structure is initialized.
 *
 * When readOnly is true, all async mutation methods throw EROFS.
 */
export class ExtendedMountableFs extends MountableFs {
  #base: InMemoryFs
  #readOnly: boolean

  constructor(opts?: ExtendedMountableFsOptions) {
    const base = new InMemoryFs()
    const { readOnly, ...rest } = opts ?? {}
    super({ ...rest, base })
    this.#base = base
    this.#readOnly = readOnly ?? false
  }

  mkdirSync(path: string, options?: { recursive?: boolean }) {
    return this.#base.mkdirSync(path, options)
  }

  writeFileSync(path: string, content: string | Uint8Array) {
    return this.#base.writeFileSync(path, content)
  }

  #assertWritable(op: string): void {
    if (this.#readOnly) {
      throw new Error(`EROFS: read-only file system, ${op}`)
    }
  }

  override async writeFile(
    p: string,
    ...a: Parameters<MountableFs['writeFile']> extends [string, ...infer R] ? R : never
  ) {
    this.#assertWritable(`write '${p}'`)
    return super.writeFile(p, ...a)
  }
  override async appendFile(
    p: string,
    ...a: Parameters<MountableFs['appendFile']> extends [string, ...infer R] ? R : never
  ) {
    this.#assertWritable(`append '${p}'`)
    return super.appendFile(p, ...a)
  }
  override async mkdir(
    p: string,
    ...a: Parameters<MountableFs['mkdir']> extends [string, ...infer R] ? R : never
  ) {
    this.#assertWritable(`mkdir '${p}'`)
    return super.mkdir(p, ...a)
  }
  override async rm(
    p: string,
    ...a: Parameters<MountableFs['rm']> extends [string, ...infer R] ? R : never
  ) {
    this.#assertWritable(`rm '${p}'`)
    return super.rm(p, ...a)
  }
  override async chmod(
    p: string,
    ...a: Parameters<MountableFs['chmod']> extends [string, ...infer R] ? R : never
  ) {
    this.#assertWritable(`chmod '${p}'`)
    return super.chmod(p, ...a)
  }
  override async symlink(...a: Parameters<MountableFs['symlink']>) {
    this.#assertWritable(`symlink '${a[1]}'`)
    return super.symlink(...a)
  }
  override async link(...a: Parameters<MountableFs['link']>) {
    this.#assertWritable(`link '${a[1]}'`)
    return super.link(...a)
  }
  override async cp(
    _s: string,
    p: string,
    ...a: Parameters<MountableFs['cp']> extends [string, string, ...infer R] ? R : never
  ) {
    this.#assertWritable(`cp '${p}'`)
    return super.cp(_s, p, ...a)
  }
  override async mv(...a: Parameters<MountableFs['mv']>) {
    this.#assertWritable(`mv '${a[1]}'`)
    return super.mv(...a)
  }
  override async utimes(
    p: string,
    ...a: Parameters<MountableFs['utimes']> extends [string, ...infer R] ? R : never
  ) {
    this.#assertWritable(`utimes '${p}'`)
    return super.utimes(p, ...a)
  }
}
