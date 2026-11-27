// The argv of the child processes the pick pane waits in. Pure: no `$`.

export type Shell = 'sh' | 'powershell.exe'

// The wait runs in whichever of these starts first: sh on macOS and Linux,
// powershell.exe on Windows, where Git puts no sh, mktemp or touch on the PATH.
export const SHELLS: readonly Shell[] = ['sh', 'powershell.exe']

const POWERSHELL = ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command'] as const

/**
 * A PowerShell single-quoted literal. PowerShell ends such a string on the ASCII
 * quote and on the curly ones (U+2018 to U+201B) alike, and reads any of them
 * doubled as itself, so each is doubled.
 */
export const psQuote = (text: string): string => `'${text.replace(/['‘’‚‛]/g, '$&$&')}'`

export const probeArgv = (shell: Shell): string[] => (shell === 'sh' ? ['sh', '-c', 'exit 0'] : [...POWERSHELL, 'exit 0'])

// The waiting child polls for the sentinel and removes it once seen, so a
// finished wait leaves nothing behind. The path reaches sh as an argument, never
// as script text.
export const waitArgv = (shell: Shell, sentinel: string): string[] =>
  shell === 'sh'
    ? ['sh', '-c', 'while [ ! -e "$1" ]; do sleep 0.2; done; rm -f -- "$1"', 'sh', sentinel]
    : [
        ...POWERSHELL,
        `$p=${psQuote(sentinel)}; while (-not (Test-Path -LiteralPath $p)) { Start-Sleep -Milliseconds 200 }; Remove-Item -LiteralPath $p -Force`,
      ]

/** Removes a file the waits folder holds: the probe, or a sentinel no wait consumed. */
export const removeArgv = (shell: Shell, path: string): string[] =>
  shell === 'sh'
    ? ['sh', '-c', 'rm -f -- "$1"', 'sh', path]
    : [...POWERSHELL, `Remove-Item -LiteralPath ${psQuote(path)} -Force -ErrorAction SilentlyContinue`]
