# Print the name of this process's parent (e.g. "explorer.exe", "cmd.exe").
#
# Split out of _pause-if-doubleclicked.cmd as its own file on purpose. Inlining
# this one-liner into a `for /f ... in (`...`)` backquote block did not work:
# cmd parses the parentheses and the nested double quotes of the -Command string
# before PowerShell ever sees them, so the loop produced nothing and PARENT_NAME
# stayed empty. The failure was silent -- the probe simply never fired, which is
# indistinguishable from "not double-clicked" and would have shipped as a pause
# that never happens.
#
# A file has no quoting to get wrong. Verified: prints "powershell.exe" when run
# from a PowerShell-started process, and "explorer.exe" under Explorer.
#
# Emits nothing (not an error) when the parent cannot be determined, which the
# caller reads as "do not pause".

$me = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $PID)
if (-not $me -or -not $me.ParentProcessId) { exit 0 }

$parent = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $me.ParentProcessId)
if ($parent) { Write-Output $parent.Name }
exit 0
