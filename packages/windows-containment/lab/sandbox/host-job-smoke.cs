#nullable enable

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;

internal static class HostJobSmoke
{
    private const uint CREATE_SUSPENDED = 0x00000004;
    private const uint CREATE_NO_WINDOW = 0x08000000;
    private const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private const uint HANDLE_FLAG_INHERIT = 0x00000001;
    private const uint WAIT_OBJECT_0 = 0x00000000;
    private const uint WAIT_TIMEOUT = 0x00000102;
    private const uint STILL_ACTIVE = 259;
    private const int JobObjectBasicProcessIdList = 3;
    private const int JobObjectBasicUIRestrictions = 4;
    private const int JobObjectExtendedLimitInformation = 9;
    private const int SmokeTimeoutMilliseconds = 30_000;
    private const string TempDirectoryPrefix = "pc-sdk-next-cx004-host-smoke-";

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO
    {
        internal uint cb;
        internal string? lpReserved;
        internal string? lpDesktop;
        internal string? lpTitle;
        internal uint dwX;
        internal uint dwY;
        internal uint dwXSize;
        internal uint dwYSize;
        internal uint dwXCountChars;
        internal uint dwYCountChars;
        internal uint dwFillAttribute;
        internal uint dwFlags;
        internal ushort wShowWindow;
        internal ushort cbReserved2;
        internal IntPtr lpReserved2;
        internal IntPtr hStdInput;
        internal IntPtr hStdOutput;
        internal IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION
    {
        internal IntPtr hProcess;
        internal IntPtr hThread;
        internal uint dwProcessId;
        internal uint dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        internal long PerProcessUserTimeLimit;
        internal long PerJobUserTimeLimit;
        internal uint LimitFlags;
        internal UIntPtr MinimumWorkingSetSize;
        internal UIntPtr MaximumWorkingSetSize;
        internal uint ActiveProcessLimit;
        internal UIntPtr Affinity;
        internal uint PriorityClass;
        internal uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS
    {
        internal ulong ReadOperationCount;
        internal ulong WriteOperationCount;
        internal ulong OtherOperationCount;
        internal ulong ReadTransferCount;
        internal ulong WriteTransferCount;
        internal ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        internal JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        internal IO_COUNTERS IoInfo;
        internal UIntPtr ProcessMemoryLimit;
        internal UIntPtr JobMemoryLimit;
        internal UIntPtr PeakProcessMemoryUsed;
        internal UIntPtr PeakJobMemoryUsed;
    }

    private sealed class LedgerHandle
    {
        internal LedgerHandle(string kind, IntPtr value)
        {
            Kind = kind;
            Value = value;
            Acquired = value != IntPtr.Zero && value != new IntPtr(-1);
        }

        internal string Kind { get; }
        internal IntPtr Value { get; }
        internal bool Acquired { get; }
        internal bool CloseAttempted { get; private set; }
        internal bool Closed { get; private set; }
        internal int CloseError { get; private set; }

        internal void CloseExactlyOnce()
        {
            if (!Acquired || CloseAttempted)
            {
                return;
            }

            CloseAttempted = true;
            Closed = CloseHandle(Value);
            if (!Closed)
            {
                CloseError = Marshal.GetLastWin32Error();
            }
        }
    }

    private sealed class SmokeEvidence
    {
        internal string Result = "failed";
        internal string Failure = string.Empty;
        internal bool FakeChildOnly;
        internal bool CreateSuspended;
        internal bool InheritHandles;
        internal uint JobLimitFlags;
        internal uint UiRestrictions;
        internal uint CreatedProcessId;
        internal uint ProcessHandleId;
        internal bool ProcessIdMatched;
        internal uint MembershipAssignedCount;
        internal uint MembershipProcessCount;
        internal ulong MembershipProcessId;
        internal bool MembershipPidMatched;
        internal uint ResumeThreadResult = uint.MaxValue;
        internal bool MarkerProgressObserved;
        internal bool ChildLiveBeforeJobClose;
        internal bool JobClosed;
        internal bool ChildSignaled;
        internal bool MarkerStopped;
        internal bool TempRootRenamed;
        internal bool TempRootReleased;
        internal long ElapsedMilliseconds;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObjectW(IntPtr lpJobAttributes, string? lpName);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetInformationJobObject(
        IntPtr hJob,
        int JobObjectInfoClass,
        IntPtr lpJobObjectInfo,
        uint cbJobObjectInfoLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool QueryInformationJobObject(
        IntPtr hJob,
        int JobObjectInfoClass,
        IntPtr lpJobObjectInfo,
        uint cbJobObjectInfoLength,
        out uint lpReturnLength);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreateProcessW(
        string lpApplicationName,
        StringBuilder lpCommandLine,
        IntPtr lpProcessAttributes,
        IntPtr lpThreadAttributes,
        [MarshalAs(UnmanagedType.Bool)] bool bInheritHandles,
        uint dwCreationFlags,
        IntPtr lpEnvironment,
        string lpCurrentDirectory,
        ref STARTUPINFO lpStartupInfo,
        out PROCESS_INFORMATION lpProcessInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsProcessInJob(
        IntPtr ProcessHandle,
        IntPtr JobHandle,
        [MarshalAs(UnmanagedType.Bool)] out bool Result);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint GetProcessId(IntPtr Process);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr hThread);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetExitCodeProcess(IntPtr hProcess, out uint lpExitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool TerminateProcess(IntPtr hProcess, uint uExitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetHandleInformation(IntPtr hObject, out uint lpdwFlags);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr hObject);

    private static int Main(string[] args)
    {
        if (args.Length == 3 && string.Equals(args[0], "--child", StringComparison.Ordinal))
        {
            return RunFakeChild(args[1], args[2]);
        }

        if (args.Length != 1 || !string.Equals(args[0], "--host-smoke", StringComparison.Ordinal))
        {
            Console.Error.WriteLine("Usage: host-job-smoke --host-smoke");
            return 64;
        }

        return RunHostSmoke();
    }

    private static int RunFakeChild(string markerPath, string challenge)
    {
        try
        {
            if (!IsLowerHex(challenge, 64))
            {
                return 65;
            }

            string fullMarkerPath = Path.GetFullPath(markerPath);
            string? directory = Path.GetDirectoryName(fullMarkerPath);
            if (directory == null ||
                !string.Equals(Path.GetFileName(fullMarkerPath), "progress.marker", StringComparison.Ordinal) ||
                !IsDedicatedTempDirectory(directory) ||
                (File.GetAttributes(directory) & FileAttributes.ReparsePoint) != 0)
            {
                return 66;
            }

            using (FileStream stream = new FileStream(
                fullMarkerPath,
                FileMode.CreateNew,
                FileAccess.Write,
                FileShare.ReadWrite | FileShare.Delete,
                4096,
                FileOptions.WriteThrough))
            using (StreamWriter writer = new StreamWriter(stream, new UTF8Encoding(false), 1024, true))
            {
                for (ulong sequence = 0; ; sequence++)
                {
                    writer.Write(challenge);
                    writer.Write(':');
                    writer.Write(sequence.ToString(CultureInfo.InvariantCulture));
                    writer.Write('\n');
                    writer.Flush();
                    stream.Flush(true);
                    Thread.Sleep(50);
                }
            }
        }
        catch
        {
            return 67;
        }
    }

    private static int RunHostSmoke()
    {
        SmokeEvidence evidence = new SmokeEvidence
        {
            FakeChildOnly = true,
            CreateSuspended = true,
            InheritHandles = false,
        };
        Stopwatch stopwatch = Stopwatch.StartNew();
        List<LedgerHandle> ledger = new List<LedgerHandle>();
        LedgerHandle? job = null;
        LedgerHandle? process = null;
        LedgerHandle? thread = null;
        string runRoot = Path.Combine(Path.GetTempPath(), TempDirectoryPrefix + Guid.NewGuid().ToString("N"));
        string renamedRoot = runRoot + ".release-check";

        try
        {
            Directory.CreateDirectory(runRoot);
            AssertDedicatedFreshRoot(runRoot);
            string markerPath = Path.Combine(runRoot, "progress.marker");
            string challenge = NewChallenge();

            job = new LedgerHandle("job", CreateJobObjectW(IntPtr.Zero, null));
            ledger.Add(job);
            Require(job.Acquired, "CreateJobObjectW failed", true);
            RequireNonInheritable(job);

            JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            SetJobLimits(job.Value, limits);
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION queriedLimits = QueryJobLimits(job.Value);
            evidence.JobLimitFlags = queriedLimits.BasicLimitInformation.LimitFlags;
            Require(evidence.JobLimitFlags == JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
                "job limit flags did not equal kill-on-close", false);

            evidence.UiRestrictions = QueryUiRestrictions(job.Value);
            Require(evidence.UiRestrictions == 0, "job UI restrictions were not zero", false);

            string applicationPath;
            string commandLine;
            BuildChildCommand(markerPath, challenge, out applicationPath, out commandLine);
            IntPtr environment = BuildMinimalEnvironmentBlock();
            try
            {
                STARTUPINFO startupInfo = new STARTUPINFO
                {
                    cb = checked((uint)Marshal.SizeOf<STARTUPINFO>()),
                };
                PROCESS_INFORMATION processInformation;
                bool created = CreateProcessW(
                    applicationPath,
                    new StringBuilder(commandLine),
                    IntPtr.Zero,
                    IntPtr.Zero,
                    false,
                    CREATE_SUSPENDED | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT,
                    environment,
                    runRoot,
                    ref startupInfo,
                    out processInformation);
                Require(created, "CreateProcessW failed", true);

                process = new LedgerHandle("process", processInformation.hProcess);
                thread = new LedgerHandle("thread", processInformation.hThread);
                ledger.Add(process);
                ledger.Add(thread);
                Require(process.Acquired && thread.Acquired, "CreateProcessW returned invalid handles", false);
                RequireNonInheritable(process);
                RequireNonInheritable(thread);

                evidence.CreatedProcessId = processInformation.dwProcessId;
                evidence.ProcessHandleId = GetProcessId(process.Value);
                evidence.ProcessIdMatched = evidence.ProcessHandleId != 0 &&
                    evidence.ProcessHandleId == evidence.CreatedProcessId;
                Require(evidence.ProcessIdMatched, "process handle PID did not match CreateProcessW PID", true);

                Require(AssignProcessToJobObject(job.Value, process.Value),
                    "AssignProcessToJobObject failed", true);
                bool inJob;
                Require(IsProcessInJob(process.Value, job.Value, out inJob),
                    "IsProcessInJob failed", true);
                Require(inJob, "child was not in the leaf job", false);

                QueryExactMembership(
                    job.Value,
                    evidence.ProcessHandleId,
                    out evidence.MembershipAssignedCount,
                    out evidence.MembershipProcessCount,
                    out evidence.MembershipProcessId,
                    out evidence.MembershipPidMatched);
                Require(evidence.MembershipAssignedCount == 1 &&
                    evidence.MembershipProcessCount == 1 &&
                    evidence.MembershipPidMatched,
                    "job membership was not exactly the created PID", false);

                evidence.ResumeThreadResult = ResumeThread(thread.Value);
                if (evidence.ResumeThreadResult == uint.MaxValue)
                {
                    Require(false, "ResumeThread failed", true);
                }
                Require(evidence.ResumeThreadResult == 1,
                    "ResumeThread did not return the exact initial suspend count", false);
                thread.CloseExactlyOnce();
                Require(thread.Closed, "thread handle close was not positive", false);

                evidence.MarkerProgressObserved = WaitForMarkerProgress(markerPath, stopwatch);
                Require(evidence.MarkerProgressObserved, "fake child marker did not make progress", false);

                uint liveWait = WaitForSingleObject(process.Value, 0);
                uint liveExitCode;
                Require(GetExitCodeProcess(process.Value, out liveExitCode),
                    "pre-close GetExitCodeProcess failed", true);
                evidence.ChildLiveBeforeJobClose = liveWait == WAIT_TIMEOUT && liveExitCode == STILL_ACTIVE;
                Require(evidence.ChildLiveBeforeJobClose,
                    "fake child was not positively live immediately before job close", false);

                job.CloseExactlyOnce();
                evidence.JobClosed = job.Closed;
                Require(evidence.JobClosed, "sole job handle close was not positive", false);

                uint remaining = RemainingMilliseconds(stopwatch);
                uint waitResult = WaitForSingleObject(process.Value, remaining);
                evidence.ChildSignaled = waitResult == WAIT_OBJECT_0;
                Require(evidence.ChildSignaled,
                    waitResult == WAIT_TIMEOUT ? "child did not signal before timeout" : "child wait failed",
                    waitResult != WAIT_TIMEOUT);

                uint exitCode;
                Require(GetExitCodeProcess(process.Value, out exitCode), "GetExitCodeProcess failed", true);
                Require(exitCode != STILL_ACTIVE, "signaled child still reported active", false);

                process.CloseExactlyOnce();
                Require(process.Closed, "process handle close was not positive", false);

                evidence.MarkerStopped = ProveMarkerStopped(markerPath);
                Require(evidence.MarkerStopped, "marker changed after child termination", false);

                Directory.Move(runRoot, renamedRoot);
                evidence.TempRootRenamed = Directory.Exists(renamedRoot) && !Directory.Exists(runRoot);
                Require(evidence.TempRootRenamed, "temp root rename proof failed", false);
                Directory.Move(renamedRoot, runRoot);
                Directory.Delete(runRoot, true);
                evidence.TempRootReleased = !Directory.Exists(runRoot) && !Directory.Exists(renamedRoot);
                Require(evidence.TempRootReleased, "temp root release proof failed", false);

                evidence.Result = "passed";
            }
            finally
            {
                Marshal.FreeHGlobal(environment);
            }
        }
        catch (Exception exception)
        {
            evidence.Failure = exception.Message;
        }
        finally
        {
            if (thread != null && thread.Acquired && !thread.CloseAttempted)
            {
                thread.CloseExactlyOnce();
            }

            if (job != null && job.Acquired && !job.CloseAttempted)
            {
                job.CloseExactlyOnce();
                evidence.JobClosed = job.Closed;
            }

            if (process != null && process.Acquired && !process.CloseAttempted)
            {
                uint wait = WaitForSingleObject(process.Value, 2_000);
                if (wait != WAIT_OBJECT_0)
                {
                    TerminateProcess(process.Value, 0xEE);
                    WaitForSingleObject(process.Value, 2_000);
                }
                process.CloseExactlyOnce();
            }

            TryDeleteOwnedRoot(runRoot, renamedRoot);
            stopwatch.Stop();
            evidence.ElapsedMilliseconds = stopwatch.ElapsedMilliseconds;
            Console.Out.WriteLine(SerializeEvidence(evidence, ledger));
        }

        return string.Equals(evidence.Result, "passed", StringComparison.Ordinal) ? 0 : 1;
    }

    private static void SetJobLimits(IntPtr job, JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits)
    {
        int size = Marshal.SizeOf<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>();
        IntPtr buffer = Marshal.AllocHGlobal(size);
        try
        {
            Marshal.StructureToPtr(limits, buffer, false);
            Require(SetInformationJobObject(job, JobObjectExtendedLimitInformation, buffer, checked((uint)size)),
                "SetInformationJobObject failed", true);
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    private static JOBOBJECT_EXTENDED_LIMIT_INFORMATION QueryJobLimits(IntPtr job)
    {
        int size = Marshal.SizeOf<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>();
        IntPtr buffer = Marshal.AllocHGlobal(size);
        try
        {
            uint returned;
            Require(QueryInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                buffer,
                checked((uint)size),
                out returned),
                "QueryInformationJobObject limits failed", true);
            Require(returned == 0 || returned == size, "unexpected job-limit query size", false);
            return Marshal.PtrToStructure<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>(buffer);
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    private static uint QueryUiRestrictions(IntPtr job)
    {
        int size = sizeof(uint);
        IntPtr buffer = Marshal.AllocHGlobal(size);
        try
        {
            Marshal.WriteInt32(buffer, 0);
            uint returned;
            Require(QueryInformationJobObject(
                job,
                JobObjectBasicUIRestrictions,
                buffer,
                checked((uint)size),
                out returned),
                "QueryInformationJobObject UI restrictions failed", true);
            Require(returned == 0 || returned == size, "unexpected UI-restriction query size", false);
            return unchecked((uint)Marshal.ReadInt32(buffer));
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    private static void QueryExactMembership(
        IntPtr job,
        uint expectedProcessId,
        out uint assignedCount,
        out uint processCount,
        out ulong membershipProcessId,
        out bool pidMatched)
    {
        const int bufferSize = 64;
        IntPtr buffer = Marshal.AllocHGlobal(bufferSize);
        try
        {
            for (int offset = 0; offset < bufferSize; offset += sizeof(int))
            {
                Marshal.WriteInt32(buffer, offset, 0);
            }

            uint returned;
            Require(QueryInformationJobObject(
                job,
                JobObjectBasicProcessIdList,
                buffer,
                bufferSize,
                out returned),
                "QueryInformationJobObject membership failed", true);
            assignedCount = unchecked((uint)Marshal.ReadInt32(buffer, 0));
            processCount = unchecked((uint)Marshal.ReadInt32(buffer, 4));
            membershipProcessId = IntPtr.Size == 8
                ? unchecked((ulong)Marshal.ReadInt64(buffer, 8))
                : unchecked((uint)Marshal.ReadInt32(buffer, 8));
            pidMatched = processCount == 1 && membershipProcessId == expectedProcessId;
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    private static bool WaitForMarkerProgress(string markerPath, Stopwatch stopwatch)
    {
        long lastLength = -1;
        int increases = 0;
        while (stopwatch.ElapsedMilliseconds < 10_000)
        {
            try
            {
                FileInfo marker = new FileInfo(markerPath);
                if (marker.Exists && marker.Length > lastLength)
                {
                    lastLength = marker.Length;
                    increases++;
                    if (increases >= 2)
                    {
                        return true;
                    }
                }
            }
            catch (IOException)
            {
                // The cooperative child may be between a write and flush.
            }

            Thread.Sleep(25);
        }

        return false;
    }

    private static bool ProveMarkerStopped(string markerPath)
    {
        byte[] before;
        using (FileStream stream = new FileStream(markerPath, FileMode.Open, FileAccess.Read, FileShare.None))
        {
            before = HashStream(stream);
        }

        Thread.Sleep(250);

        byte[] after;
        using (FileStream stream = new FileStream(markerPath, FileMode.Open, FileAccess.Read, FileShare.None))
        {
            after = HashStream(stream);
        }

        return FixedTimeEquals(before, after);
    }

    private static byte[] HashStream(Stream stream)
    {
        using (SHA256 sha256 = SHA256.Create())
        {
            return sha256.ComputeHash(stream);
        }
    }

    private static bool FixedTimeEquals(byte[] left, byte[] right)
    {
        if (left.Length != right.Length)
        {
            return false;
        }

        int difference = 0;
        for (int index = 0; index < left.Length; index++)
        {
            difference |= left[index] ^ right[index];
        }

        return difference == 0;
    }

    private static void BuildChildCommand(
        string markerPath,
        string challenge,
        out string applicationPath,
        out string commandLine)
    {
        applicationPath = Path.GetFullPath(Assembly.GetExecutingAssembly().Location);
        Require(File.Exists(applicationPath), "current executable path is unavailable", false);

        StringBuilder command = new StringBuilder();
        command.Append(QuoteArgument(applicationPath));
        command.Append(" --child ");
        command.Append(QuoteArgument(markerPath));
        command.Append(' ');
        command.Append(challenge);
        commandLine = command.ToString();
    }

    private static string QuoteArgument(string value)
    {
        if (value.IndexOf('"') >= 0 || value.EndsWith("\\", StringComparison.Ordinal))
        {
            throw new InvalidOperationException("internal child argument was not safely quoteable");
        }
        return "\"" + value + "\"";
    }

    private static IntPtr BuildMinimalEnvironmentBlock()
    {
        SortedDictionary<string, string> environment = new SortedDictionary<string, string>(
            StringComparer.OrdinalIgnoreCase);
        AddEnvironmentIfPresent(environment, "SystemRoot");
        AddEnvironmentIfPresent(environment, "WINDIR");
        AddEnvironmentIfPresent(environment, "TEMP");
        AddEnvironmentIfPresent(environment, "TMP");

        StringBuilder block = new StringBuilder();
        foreach (KeyValuePair<string, string> entry in environment)
        {
            block.Append(entry.Key);
            block.Append('=');
            block.Append(entry.Value);
            block.Append('\0');
        }
        block.Append('\0');

        byte[] bytes = Encoding.Unicode.GetBytes(block.ToString());
        IntPtr pointer = Marshal.AllocHGlobal(bytes.Length);
        Marshal.Copy(bytes, 0, pointer, bytes.Length);
        return pointer;
    }

    private static void AddEnvironmentIfPresent(IDictionary<string, string> target, string name)
    {
        string? value = Environment.GetEnvironmentVariable(name);
        if (!string.IsNullOrEmpty(value) && value.IndexOf('\0') < 0)
        {
            target[name] = value;
        }
    }

    private static void RequireNonInheritable(LedgerHandle handle)
    {
        uint flags;
        Require(GetHandleInformation(handle.Value, out flags),
            "GetHandleInformation failed for " + handle.Kind, true);
        Require((flags & HANDLE_FLAG_INHERIT) == 0,
            handle.Kind + " handle was inheritable", false);
    }

    private static uint RemainingMilliseconds(Stopwatch stopwatch)
    {
        long remaining = SmokeTimeoutMilliseconds - stopwatch.ElapsedMilliseconds;
        return remaining <= 0 ? 0 : checked((uint)remaining);
    }

    private static string NewChallenge()
    {
        byte[] bytes = new byte[32];
        using (RandomNumberGenerator random = RandomNumberGenerator.Create())
        {
            random.GetBytes(bytes);
        }

        StringBuilder hex = new StringBuilder(64);
        foreach (byte value in bytes)
        {
            hex.Append(value.ToString("x2", CultureInfo.InvariantCulture));
        }
        return hex.ToString();
    }

    private static bool IsLowerHex(string value, int expectedLength)
    {
        if (value.Length != expectedLength)
        {
            return false;
        }

        foreach (char character in value)
        {
            if (!((character >= '0' && character <= '9') ||
                (character >= 'a' && character <= 'f')))
            {
                return false;
            }
        }
        return true;
    }

    private static bool IsDedicatedTempDirectory(string path)
    {
        string fullPath = TrimEndingDirectorySeparators(Path.GetFullPath(path));
        string tempPath = TrimEndingDirectorySeparators(Path.GetFullPath(Path.GetTempPath()));
        string? parent = Path.GetDirectoryName(fullPath);
        string name = Path.GetFileName(fullPath);
        return parent != null &&
            string.Equals(TrimEndingDirectorySeparators(parent), tempPath, StringComparison.OrdinalIgnoreCase) &&
            name.StartsWith(TempDirectoryPrefix, StringComparison.Ordinal) &&
            name.Length == TempDirectoryPrefix.Length + 32 &&
            IsLowerHex(name.Substring(TempDirectoryPrefix.Length), 32);
    }

    private static string TrimEndingDirectorySeparators(string path)
    {
        string root = Path.GetPathRoot(path) ?? string.Empty;
        int length = path.Length;
        while (length > root.Length &&
            (path[length - 1] == Path.DirectorySeparatorChar ||
                path[length - 1] == Path.AltDirectorySeparatorChar))
        {
            length--;
        }
        return length == path.Length ? path : path.Substring(0, length);
    }

    private static void AssertDedicatedFreshRoot(string runRoot)
    {
        Require(IsDedicatedTempDirectory(runRoot), "run root was not the dedicated temp child", false);
        FileAttributes attributes = File.GetAttributes(runRoot);
        Require((attributes & FileAttributes.ReparsePoint) == 0, "run root was a reparse point", false);
        Require(Directory.GetFileSystemEntries(runRoot).Length == 0, "run root was not empty", false);
    }

    private static void TryDeleteOwnedRoot(string runRoot, string renamedRoot)
    {
        try
        {
            if (Directory.Exists(renamedRoot) && !Directory.Exists(runRoot))
            {
                Directory.Move(renamedRoot, runRoot);
            }
            if (Directory.Exists(runRoot) && IsDedicatedTempDirectory(runRoot))
            {
                FileAttributes attributes = File.GetAttributes(runRoot);
                if ((attributes & FileAttributes.ReparsePoint) == 0)
                {
                    Directory.Delete(runRoot, true);
                }
            }
        }
        catch
        {
            // The failed result remains authoritative; cleanup is never relabeled success.
        }
    }

    private static void Require(bool condition, string message, bool includeWin32Error)
    {
        if (condition)
        {
            return;
        }

        if (includeWin32Error)
        {
            int error = Marshal.GetLastWin32Error();
            throw new InvalidOperationException(message + " (Win32 " + error.ToString(CultureInfo.InvariantCulture) + ")");
        }

        throw new InvalidOperationException(message);
    }

    private static string SerializeEvidence(SmokeEvidence evidence, IReadOnlyList<LedgerHandle> ledger)
    {
        StringBuilder json = new StringBuilder();
        json.Append('{');
        AppendString(json, "schemaVersion", "cx-004-host-smoke-v1", true);
        AppendString(json, "classification", "host-smoke-only", true);
        AppendString(json, "result", evidence.Result, true);
        AppendString(json, "failure", evidence.Failure, true);
        AppendBool(json, "fakeChildOnly", evidence.FakeChildOnly, true);
        AppendBool(json, "createSuspended", evidence.CreateSuspended, true);
        AppendBool(json, "inheritHandles", evidence.InheritHandles, true);
        AppendNumber(json, "jobLimitFlags", evidence.JobLimitFlags, true);
        AppendNumber(json, "uiRestrictions", evidence.UiRestrictions, true);
        AppendNumber(json, "createdProcessId", evidence.CreatedProcessId, true);
        AppendNumber(json, "processHandleId", evidence.ProcessHandleId, true);
        AppendBool(json, "processIdMatched", evidence.ProcessIdMatched, true);
        AppendNumber(json, "membershipAssignedCount", evidence.MembershipAssignedCount, true);
        AppendNumber(json, "membershipProcessCount", evidence.MembershipProcessCount, true);
        AppendNumber(json, "membershipProcessId", checked((long)evidence.MembershipProcessId), true);
        AppendBool(json, "membershipPidMatched", evidence.MembershipPidMatched, true);
        AppendNumber(json, "resumeThreadResult", evidence.ResumeThreadResult, true);
        AppendBool(json, "markerProgressObserved", evidence.MarkerProgressObserved, true);
        AppendBool(json, "childLiveBeforeJobClose", evidence.ChildLiveBeforeJobClose, true);
        AppendBool(json, "jobClosed", evidence.JobClosed, true);
        AppendBool(json, "childSignaled", evidence.ChildSignaled, true);
        AppendBool(json, "markerStopped", evidence.MarkerStopped, true);
        AppendBool(json, "tempRootRenamed", evidence.TempRootRenamed, true);
        AppendBool(json, "tempRootReleased", evidence.TempRootReleased, true);
        AppendNumber(json, "elapsedMilliseconds", evidence.ElapsedMilliseconds, true);
        json.Append("\"handleLedger\":[");
        for (int index = 0; index < ledger.Count; index++)
        {
            if (index > 0)
            {
                json.Append(',');
            }
            LedgerHandle handle = ledger[index];
            json.Append('{');
            AppendString(json, "kind", handle.Kind, true);
            AppendBool(json, "acquired", handle.Acquired, true);
            AppendBool(json, "closeAttempted", handle.CloseAttempted, true);
            AppendBool(json, "closed", handle.Closed, true);
            AppendNumber(json, "closeError", handle.CloseError, false);
            json.Append('}');
        }
        json.Append("]}");
        return json.ToString();
    }

    private static void AppendString(StringBuilder json, string name, string value, bool comma)
    {
        json.Append('"').Append(name).Append("\":\"");
        foreach (char character in value)
        {
            switch (character)
            {
                case '\\': json.Append("\\\\"); break;
                case '"': json.Append("\\\""); break;
                case '\r': json.Append("\\r"); break;
                case '\n': json.Append("\\n"); break;
                case '\t': json.Append("\\t"); break;
                default:
                    if (character < ' ')
                    {
                        json.Append("\\u").Append(((int)character).ToString("x4", CultureInfo.InvariantCulture));
                    }
                    else
                    {
                        json.Append(character);
                    }
                    break;
            }
        }
        json.Append('"');
        if (comma) json.Append(',');
    }

    private static void AppendBool(StringBuilder json, string name, bool value, bool comma)
    {
        json.Append('"').Append(name).Append("\":").Append(value ? "true" : "false");
        if (comma) json.Append(',');
    }

    private static void AppendNumber(StringBuilder json, string name, long value, bool comma)
    {
        json.Append('"').Append(name).Append("\":").Append(value.ToString(CultureInfo.InvariantCulture));
        if (comma) json.Append(',');
    }

    private static void AppendNumber(StringBuilder json, string name, uint value, bool comma)
    {
        AppendNumber(json, name, (long)value, comma);
    }
}
