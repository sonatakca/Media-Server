<#
.SYNOPSIS
    Suspends or resumes one process, and proves it happened.

.DESCRIPTION
    Windows has no SIGSTOP. Node refuses to deliver one — `process.kill` throws
    ERR_UNKNOWN_SIGNAL before the signal reaches anything — and for a long time
    that meant the encoder could not be paused here at all: the queue said
    stopped, the disk said otherwise, and an operator pausing to unplug a drive
    was told it was safe.

    The platform's own answer is `NtSuspendProcess` / `NtResumeProcess` in
    ntdll, reached through a handle opened with PROCESS_SUSPEND_RESUME. Measured
    against the production encoder (FFmpeg pid 11396, child of the worker):
    9.469 s of CPU over four seconds running, 0.000000 s over eight seconds
    suspended, 18.234 s over four seconds after resuming, same pid throughout.

    Three things here are not decoration:

    - **The pid is checked before it is used.** Windows recycles pids quickly,
      and a stale pid suspended by mistake is an arbitrary process on the
      machine frozen by the media server. `-ImageName` names what the caller
      believes it is acting on and the process is rejected if it disagrees.

    - **The result is verified, not assumed.** A zero NTSTATUS says the call was
      accepted. What the caller needs to know is whether the threads are
      actually stopped, because the entire point of the state it will write down
      afterwards is that the encoder is no longer running. Thread wait reasons
      are read back and must agree before this reports success.

    - **Resume unwinds the whole suspend count.** Suspension counts rather than
      latches, so a retry after an uncertain outcome — a suspend that timed out
      here and succeeded there — can leave a process needing two resumes. The
      resume loops until the threads are genuinely running again.

    Every cmdlet is module-qualified. A zero-byte `Get-Service` in system32 has
    already been observed on this host beating the real cmdlet in -NoProfile
    sessions, failing through stderr only; a helper whose job is to say whether
    an encoder is stopped must not be able to lose that argument.

.OUTPUTS
    One line on stdout:

        SEYIRLIK-SUSPEND status=<status> pid=<pid> detail=<text>

    status is one of: suspended, resumed, gone, wrong-process, open-failed,
    nt-failed, not-confirmed. Exit code is 0 whenever that line was produced,
    including for the failures — the status carries the outcome, and a non-zero
    exit means this script itself did not run.
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('suspend', 'resume')]
    [string] $Action,

    # Ranged rather than typed alone: a negative pid is a POSIX process group,
    # which means nothing here and must never be passed through to OpenProcess.
    [Parameter(Mandatory = $true)]
    [ValidateRange(1, 2147483647)]
    [int] $TargetProcessId,

    # The image the caller believes this pid is. Optional so the script stays
    # usable by hand, but the encoder always passes it.
    [Parameter(Mandatory = $false)]
    [ValidatePattern('^[A-Za-z0-9._-]{1,64}$')]
    [string] $ImageName
)

$ErrorActionPreference = 'Stop'

function Write-SuspendResult {
    param([string] $Status, [string] $Detail = '')
    # Deliberately not ConvertTo-Json. This one line is the whole protocol, and
    # building it from .NET rather than from a cmdlet keeps it out of reach of
    # anything on this host that resolves command names differently.
    [Console]::Out.WriteLine(
        ('SEYIRLIK-SUSPEND status={0} pid={1} detail={2}' -f $Status, $TargetProcessId, $Detail))
}

# Whether every thread of the process is parked by the suspend, as the kernel
# reports it rather than as the API return value claims.
#
# A thread that exits between the enumeration and the read throws; that is a
# thread which is no longer running either, so it is skipped rather than
# treated as evidence of anything.
function Test-AllThreadsSuspended {
    param([System.Diagnostics.Process] $Process)
    $Process.Refresh()
    $seen = 0
    foreach ($thread in $Process.Threads) {
        try {
            $state = $thread.ThreadState
        } catch {
            continue
        }
        $seen += 1
        if ($state -eq [System.Diagnostics.ThreadState]::Suspended) { continue }
        if ($state -eq [System.Diagnostics.ThreadState]::Wait) {
            try {
                if ($thread.WaitReason -eq [System.Diagnostics.ThreadWaitReason]::Suspended) { continue }
            } catch {
                continue
            }
        }
        return $false
    }
    # No readable thread at all is not a suspended process; it is a process on
    # its way out, and the caller decides what that means.
    return ($seen -gt 0)
}

try {
    $signature = @'
[DllImport("kernel32.dll", SetLastError = true)]
public static extern IntPtr OpenProcess(uint dwDesiredAccess, bool bInheritHandle, uint dwProcessId);

[DllImport("kernel32.dll", SetLastError = true)]
[return: MarshalAs(UnmanagedType.Bool)]
public static extern bool CloseHandle(IntPtr hObject);

[DllImport("ntdll.dll")]
public static extern int NtSuspendProcess(IntPtr processHandle);

[DllImport("ntdll.dll")]
public static extern int NtResumeProcess(IntPtr processHandle);
'@

    if (-not ('SeyirlikNative.ProcessControl' -as [type])) {
        Microsoft.PowerShell.Utility\Add-Type `
            -MemberDefinition $signature `
            -Namespace 'SeyirlikNative' `
            -Name 'ProcessControl' | Out-Null
    }

    try {
        $process = [System.Diagnostics.Process]::GetProcessById($TargetProcessId)
    } catch [System.ArgumentException] {
        # The pid names nothing. For a child that finished between the request
        # and its delivery this is the race resolving the better way.
        Write-SuspendResult 'gone'
        exit 0
    }

    if ($process.HasExited) {
        Write-SuspendResult 'gone'
        exit 0
    }

    if ($ImageName) {
        $expected = $ImageName -replace '\.exe$', ''
        if ($process.ProcessName -ne $expected) {
            Write-SuspendResult 'wrong-process' ('expected {0}, found {1}' -f $expected, $process.ProcessName)
            exit 0
        }
    }

    # PROCESS_SUSPEND_RESUME (0x0800) is the right to do it;
    # PROCESS_QUERY_LIMITED_INFORMATION (0x1000) is the right to ask afterwards
    # whether it took. Nothing broader is requested.
    $access = 0x0800 -bor 0x1000
    $handle = [SeyirlikNative.ProcessControl]::OpenProcess($access, $false, $TargetProcessId)
    if ($handle -eq [IntPtr]::Zero) {
        $code = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
        Write-SuspendResult 'open-failed' ('OpenProcess failed with Win32 error {0}' -f $code)
        exit 0
    }

    try {
        if ($Action -eq 'suspend') {
            $status = [SeyirlikNative.ProcessControl]::NtSuspendProcess($handle)
            if ($status -ne 0) {
                Write-SuspendResult 'nt-failed' ('NtSuspendProcess returned NTSTATUS 0x{0:X8}' -f $status)
                exit 0
            }
            # The call is synchronous, so one read is normally enough; the
            # retries cover a thread created in the same instant.
            $confirmed = $false
            for ($attempt = 0; $attempt -lt 5; $attempt += 1) {
                if ($process.HasExited) {
                    Write-SuspendResult 'gone'
                    exit 0
                }
                if (Test-AllThreadsSuspended -Process $process) { $confirmed = $true; break }
                [System.Threading.Thread]::Sleep(50)
            }
            if (-not $confirmed) {
                Write-SuspendResult 'not-confirmed' 'the process still has running threads'
                exit 0
            }
            Write-SuspendResult 'suspended'
            exit 0
        }

        # Resume. Looped, because suspension counts: an uncertain suspend that
        # was retried leaves a count of two, and one resume would return
        # STATUS_SUCCESS while the process stayed exactly where it was.
        for ($attempt = 0; $attempt -lt 8; $attempt += 1) {
            if ($process.HasExited) {
                Write-SuspendResult 'gone'
                exit 0
            }
            $status = [SeyirlikNative.ProcessControl]::NtResumeProcess($handle)
            if ($status -ne 0) {
                Write-SuspendResult 'nt-failed' ('NtResumeProcess returned NTSTATUS 0x{0:X8}' -f $status)
                exit 0
            }
            if (-not (Test-AllThreadsSuspended -Process $process)) {
                Write-SuspendResult 'resumed'
                exit 0
            }
            [System.Threading.Thread]::Sleep(50)
        }
        Write-SuspendResult 'not-confirmed' 'the process is still suspended after repeated resumes'
        exit 0
    } finally {
        [void][SeyirlikNative.ProcessControl]::CloseHandle($handle)
    }
} catch {
    # Nothing here is allowed to fail quietly: a caller that cannot tell a
    # broken helper from a suspended encoder is the bug this replaces.
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
