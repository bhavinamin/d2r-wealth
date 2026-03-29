using Microsoft.Win32;
using System.Diagnostics;

namespace D2Wealth.Gateway.Win;

internal sealed class GatewayProcessManager
{
    private readonly SettingsStore _settingsStore;
    private readonly GatewayLogger _logger;
    private Process? _process;

    public GatewayProcessManager(SettingsStore settingsStore, GatewayLogger logger)
    {
        _settingsStore = settingsStore;
        _logger = logger;
    }

    public void Start()
    {
        if (_process is { HasExited: false })
        {
            return;
        }

        var nodePath = ResolveNodePath();
        var scriptPath = ResolveServerScriptPath();
        if (nodePath is null || scriptPath is null)
        {
            throw new InvalidOperationException("Unable to locate node.exe or gateway/server.mjs for the native gateway wrapper.");
        }

        var psi = new ProcessStartInfo
        {
            FileName = nodePath,
            Arguments = $"\"{scriptPath}\"",
            UseShellExecute = false,
            CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden,
            WorkingDirectory = AppContext.BaseDirectory,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        psi.Environment["D2_GATEWAY_SETTINGS_PATH"] = _settingsStore.SettingsPath;

        var process = new Process
        {
            StartInfo = psi,
            EnableRaisingEvents = true,
        };
        process.OutputDataReceived += (_, args) =>
        {
            if (!string.IsNullOrWhiteSpace(args.Data))
            {
                _logger.Info($"gateway> {args.Data}");
            }
        };
        process.ErrorDataReceived += (_, args) =>
        {
            if (!string.IsNullOrWhiteSpace(args.Data))
            {
                _logger.Warn($"gateway! {args.Data}");
            }
        };
        process.Exited += (_, _) => _logger.Warn($"Gateway process exited with code {process.ExitCode}.");

        if (!process.Start())
        {
            process.Dispose();
            throw new InvalidOperationException("Failed to start gateway process.");
        }

        process.BeginOutputReadLine();
        process.BeginErrorReadLine();
        _logger.Info($"Started gateway process {process.Id}.");
        _process = process;
    }

    public async Task RestartAsync()
    {
        await StopAsync();
        Start();
    }

    public async Task StopAsync()
    {
        if (_process is null)
        {
            return;
        }

        try
        {
            if (!_process.HasExited)
            {
                _logger.Info($"Stopping gateway process {_process.Id}.");
                _process.Kill(entireProcessTree: true);
                await _process.WaitForExitAsync();
            }
        }
        catch
        {
            _logger.Warn("Gateway process stop raised an exception and will be ignored.");
        }
        finally
        {
            _process.Dispose();
            _process = null;
        }
    }

    public void ApplyAutoStart(bool enabled)
    {
        using var key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run", writable: true)
            ?? Registry.CurrentUser.CreateSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run");

        const string valueName = "D2WealthGatewayNative";
        if (enabled)
        {
            key?.SetValue(valueName, $"\"{Application.ExecutablePath}\"");
        }
        else
        {
            key?.DeleteValue(valueName, false);
        }
    }

    private static string? ResolveNodePath()
    {
        var bundled = Path.Combine(AppContext.BaseDirectory, "node", "node.exe");
        if (File.Exists(bundled))
        {
            return bundled;
        }

        return "node";
    }

    private static string? ResolveServerScriptPath()
    {
        var local = Path.Combine(AppContext.BaseDirectory, "gateway", "server.mjs");
        if (File.Exists(local))
        {
            return local;
        }

        for (var current = new DirectoryInfo(AppContext.BaseDirectory); current is not null; current = current.Parent)
        {
            var candidate = Path.Combine(current.FullName, "gateway", "server.mjs");
            if (File.Exists(candidate))
            {
                return candidate;
            }
        }

        return null;
    }
}
