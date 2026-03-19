export interface CommandSpec {
  /** The SSH command to execute */
  command: string
  /** Simulated think time before this command (ms). 0 = fire immediately. */
  thinkTimeMs: number
}

export interface SessionProfile {
  name: string
  description: string
  /** Ordered commands with inter-command timing */
  commands: CommandSpec[]
}
