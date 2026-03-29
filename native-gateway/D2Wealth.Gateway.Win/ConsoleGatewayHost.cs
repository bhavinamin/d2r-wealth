namespace D2Wealth.Gateway.Win;

internal sealed class ConsoleGatewayHost
{
    private readonly GatewayLogger _logger;
    private readonly SettingsStore _settingsStore;
    private readonly GatewayProcessManager _processManager;
    private readonly GatewayApiClient _apiClient;

    public ConsoleGatewayHost(GatewayLogger logger, SettingsStore settingsStore)
    {
        _logger = logger;
        _settingsStore = settingsStore;
        _processManager = new GatewayProcessManager(_settingsStore, _logger);
        _apiClient = new GatewayApiClient(_settingsStore);
    }

    public async Task RunAsync(string[] args)
    {
        var command = args.FirstOrDefault()?.Trim().ToLowerInvariant() ?? "run";
        var commandArgs = args.Skip(1).ToArray();

        switch (command)
        {
            case "run":
                await RunMonitorAsync();
                return;
            case "status":
                await PrintStatusAsync();
                return;
            case "pair":
                await PairAsync();
                return;
            case "disconnect":
                await DisconnectAsync();
                return;
            case "config":
                await ConfigureAsync(commandArgs);
                return;
            case "help":
            case "--help":
            case "-h":
                PrintHelp();
                return;
            default:
                throw new InvalidOperationException($"Unknown command '{command}'. Run 'help' for available commands.");
        }
    }

    private async Task RunMonitorAsync()
    {
        var settings = _settingsStore.Load();
        _logger.Info($"Gateway console mode started. Settings: {_settingsStore.SettingsPath}");
        _logger.Info($"Log file: {_logger.LogPath}");
        _logger.Info($"Monitoring save directory: {settings.SaveDir}");
        _logger.Info($"Backend: {settings.BackendUrl}");

        _processManager.ApplyAutoStart(settings.AutoStart);
        _processManager.Start();

        using var cancellation = new CancellationTokenSource();
        Console.CancelKeyPress += (_, args) =>
        {
            args.Cancel = true;
            cancellation.Cancel();
        };

        string? lastSummary = null;
        try
        {
            while (!cancellation.IsCancellationRequested)
            {
                var health = await _apiClient.LoadHealthAsync(settings, cancellation.Token);
                var summary = DescribeHealth(settings, health);
                if (!string.Equals(summary, lastSummary, StringComparison.Ordinal))
                {
                    _logger.Info(summary);
                    lastSummary = summary;
                }

                await Task.Delay(TimeSpan.FromSeconds(3), cancellation.Token);
            }
        }
        catch (OperationCanceledException)
        {
            _logger.Info("Gateway console mode stopped by user.");
        }
        finally
        {
            await _processManager.StopAsync();
        }
    }

    private async Task PrintStatusAsync()
    {
        var settings = _settingsStore.Load();
        var health = await _apiClient.LoadHealthAsync(settings);
        _logger.Info($"Settings file: {_settingsStore.SettingsPath}");
        _logger.Info($"Save directory: {settings.SaveDir}");
        _logger.Info($"Backend: {settings.BackendUrl}");
        _logger.Info($"Client id: {settings.ClientId}");
        _logger.Info(DescribeHealth(settings, health));
    }

    private async Task PairAsync()
    {
        var settings = _settingsStore.Load();
        _logger.Info($"Starting Discord pairing for client '{settings.ClientId}'.");
        _processManager.Start();
        await _apiClient.PairGatewayAsync(settings, status => _logger.Info(status));
        _settingsStore.Save(settings);
        await _processManager.RestartAsync();

        var health = await _apiClient.WaitForHealthyStateAsync(
            settings,
            status => !string.IsNullOrWhiteSpace(status.SyncToken) && (status.LastBackendSyncAt is not null || status.LastBackendSyncError is not null));

        _logger.Info(DescribeHealth(settings, health));
    }

    private async Task DisconnectAsync()
    {
        var settings = _settingsStore.Load();
        _logger.Info("Disconnecting gateway from backend account.");
        await _apiClient.DisconnectGatewayAsync(settings);
        await _processManager.RestartAsync();
        var health = await _apiClient.LoadHealthAsync(settings);
        _logger.Info(DescribeHealth(settings, health));
    }

    private async Task ConfigureAsync(string[] args)
    {
        var settings = _settingsStore.Load();

        for (var index = 0; index < args.Length; index += 2)
        {
            if (index + 1 >= args.Length)
            {
                throw new InvalidOperationException($"Missing value for option '{args[index]}'.");
            }

            var option = args[index];
            var value = args[index + 1];
            switch (option)
            {
                case "--save-dir":
                    settings.SaveDir = value;
                    break;
                case "--backend-url":
                    settings.BackendUrl = value;
                    settings.DashboardUrl = value;
                    break;
                case "--host":
                    settings.Host = value;
                    break;
                case "--port":
                    settings.Port = int.Parse(value);
                    break;
                case "--client-id":
                    settings.ClientId = value;
                    break;
                case "--auto-start":
                    settings.AutoStart = bool.Parse(value);
                    break;
                default:
                    throw new InvalidOperationException($"Unknown config option '{option}'.");
            }
        }

        _settingsStore.Save(settings);
        _processManager.ApplyAutoStart(settings.AutoStart);
        _processManager.Start();
        var health = await _apiClient.SaveGatewaySettingsAsync(settings);
        _logger.Info("Gateway configuration saved.");
        _logger.Info(DescribeHealth(settings, health));
    }

    private static string DescribeHealth(GatewaySettings settings, GatewayHealth? health)
    {
        if (health is null)
        {
            return $"Gateway API not reachable at http://{settings.Host}:{settings.Port}.";
        }

        var validation = health.SaveValidation is null
            ? "validation unknown"
            : health.SaveValidation.Valid
                ? $"validation ok ({health.SaveValidation.CharacterCount} characters)"
                : $"validation failed ({health.SaveValidation.Message})";
        var sync = !string.IsNullOrWhiteSpace(health.LastBackendSyncError)
            ? $"sync error: {health.LastBackendSyncError}"
            : !string.IsNullOrWhiteSpace(health.LastBackendSyncAt)
                ? $"last sync: {health.LastBackendSyncAt}"
                : string.IsNullOrWhiteSpace(health.SyncToken)
                    ? "not linked"
                    : "linked, waiting for first sync";

        return $"Gateway ok={health.Ok}; saveDir='{health.SaveDir}'; {validation}; {sync}.";
    }

    private void PrintHelp()
    {
        _logger.Info("D2 Wealth Gateway console commands:");
        _logger.Info("  run                     Start the local gateway and stream health/log output.");
        _logger.Info("  status                  Print saved settings and current gateway health.");
        _logger.Info("  pair                    Launch Discord pairing and wait for the first sync result.");
        _logger.Info("  disconnect              Remove the current backend link and restart the gateway.");
        _logger.Info("  config [options]        Update saved settings.");
        _logger.Info("  tray                    Start the legacy tray UI.");
        _logger.Info("  --settings-path <file>  Use an alternate settings file for isolated testing.");
        _logger.Info("Config options:");
        _logger.Info("  --save-dir <path>");
        _logger.Info("  --backend-url <url>");
        _logger.Info("  --host <hostname>");
        _logger.Info("  --port <number>");
        _logger.Info("  --client-id <id>");
        _logger.Info("  --auto-start <true|false>");
    }
}
