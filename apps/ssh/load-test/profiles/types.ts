export interface CommandSpec {
  /** The SSH command to execute */
  command: string
  /** Milliseconds since session start to fire this command */
  offset: number
}

export interface SessionProfile {
  name: string
  description: string
  /** Ordered commands with timing offsets from session start */
  commands: CommandSpec[]
}
